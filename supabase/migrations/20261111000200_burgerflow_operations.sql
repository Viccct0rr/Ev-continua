create function public.create_product(
  product_name text,
  product_category text,
  product_description text,
  product_price_cents bigint,
  initial_quantity integer,
  inventory_unit text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_product_id bigint;
begin
  if not public.has_app_permission('products:write') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  if product_name is null
    or product_category is null
    or product_description is null
    or inventory_unit is null
    or product_price_cents is null
    or initial_quantity is null
    or length(btrim(product_name)) not between 1 and 100
    or length(btrim(product_category)) not between 1 and 60
    or length(product_description) > 500
    or product_price_cents < 0
    or initial_quantity < 0
    or length(btrim(inventory_unit)) not between 1 and 24 then
    raise exception using errcode = '22023', message = 'Invalid product';
  end if;

  insert into public.products (name, category, description, price_cents)
  values (btrim(product_name), btrim(product_category), btrim(product_description), product_price_cents)
  returning id into created_product_id;

  insert into public.inventory (product_id, quantity, unit)
  values (created_product_id, initial_quantity, btrim(inventory_unit));

  return created_product_id;
end
$$;

create function public.update_product(
  target_product_id bigint,
  product_name text,
  product_category text,
  product_description text,
  product_price_cents bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_app_permission('products:write') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  if target_product_id is null
    or product_name is null
    or product_category is null
    or product_description is null
    or product_price_cents is null
    or target_product_id <= 0
    or length(btrim(product_name)) not between 1 and 100
    or length(btrim(product_category)) not between 1 and 60
    or length(product_description) > 500
    or product_price_cents < 0 then
    raise exception using errcode = '22023', message = 'Invalid product';
  end if;

  update public.products
  set name = btrim(product_name),
      category = btrim(product_category),
      description = btrim(product_description),
      price_cents = product_price_cents,
      updated_at = now()
  where id = target_product_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;
end
$$;

create function public.deactivate_product(target_product_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_app_permission('products:write') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  update public.products
  set active = false, updated_at = now()
  where id = target_product_id and active;
  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found or inactive';
  end if;
end
$$;

create function public.adjust_inventory(
  target_product_id bigint,
  new_quantity integer,
  change_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_quantity integer;
begin
  if not public.has_app_permission('inventory:write') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  if target_product_id is null or new_quantity is null or change_reason is null
    or new_quantity < 0 or length(btrim(change_reason)) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Invalid inventory adjustment';
  end if;

  select i.quantity into old_quantity
  from public.inventory as i
  where i.product_id = target_product_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  update public.inventory
  set quantity = new_quantity, updated_at = now()
  where product_id = target_product_id;

  if new_quantity <> old_quantity then
    insert into public.inventory_movements (product_id, changed_by, delta, reason)
    values (target_product_id, public.current_app_user_id(), new_quantity - old_quantity, btrim(change_reason));
  end if;
end
$$;

create function public.create_order(
  requested_order_type text,
  requested_payment_method text,
  requested_items jsonb,
  requested_delivery jsonb default null,
  requested_customer_id bigint default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id bigint := public.current_app_user_id();
  actor_role text := public.current_app_role();
  customer_id bigint;
  driver_id bigint;
  new_order_id bigint;
  new_order_code text;
  subtotal bigint := 0;
  tax bigint;
  service bigint;
  total bigint;
  stock_row record;
  item_row record;
  option_row record;
  product_row record;
  item_quantity integer;
  option_name text;
  option_value text;
  option_price bigint;
  item_modifier bigint;
  item_unit_price bigint;
  item_line_id bigint;
  has_size boolean;
  item_options jsonb;
  delivery_name text;
  delivery_phone text;
  delivery_address text;
begin
  if actor_id is null or not public.has_app_permission('orders:create') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  if requested_order_type is null
    or requested_order_type not in ('dine_in', 'pickup', 'delivery')
    or requested_payment_method is null
    or requested_payment_method not in ('cash', 'card', 'qr')
    or requested_items is null
    or jsonb_typeof(requested_items) is distinct from 'array'
    or jsonb_array_length(requested_items) not between 1 and 30 then
    raise exception using errcode = '22023', message = 'Invalid order';
  end if;

  if actor_role = 'customer' then
    customer_id := actor_id;
  else
    customer_id := requested_customer_id;
    if customer_id is null then
      select u.id into customer_id
      from public.users as u
      where u.email = 'cliente@burgerflow.local'
        and u.role_id = 'customer'
        and u.active
      order by u.id
      limit 1;
    end if;
    if customer_id is null or not exists (
      select 1 from public.users as u
      where u.id = customer_id and u.role_id = 'customer' and u.active
    ) then
      raise exception using errcode = '22023', message = 'Invalid customer';
    end if;
  end if;

  if requested_order_type = 'delivery' then
    delivery_name := btrim(coalesce(requested_delivery ->> 'name', ''));
    delivery_phone := btrim(coalesce(requested_delivery ->> 'phone', ''));
    delivery_address := btrim(coalesce(requested_delivery ->> 'address', ''));
    if length(delivery_name) not between 1 and 100
      or delivery_phone !~ '^[+0-9 ()-]{7,24}$'
      or length(delivery_address) not between 1 and 240 then
      raise exception using errcode = '22023', message = 'Invalid delivery details';
    end if;
  end if;

  for stock_row in
    select (entry.value ->> 'productId')::bigint as product_id,
      sum((entry.value ->> 'quantity')::integer)::integer as requested_quantity
    from jsonb_array_elements(requested_items) as entry(value)
    group by (entry.value ->> 'productId')::bigint
    order by (entry.value ->> 'productId')::bigint
  loop
    if stock_row.product_id <= 0 or stock_row.requested_quantity not between 1 and 750 then
      raise exception using errcode = '22023', message = 'Invalid item quantity';
    end if;
    select i.quantity into item_quantity
    from public.inventory as i
    where i.product_id = stock_row.product_id
    for update;
    if not found or item_quantity < stock_row.requested_quantity then
      raise exception using errcode = 'P0001', message = 'Insufficient inventory';
    end if;
  end loop;

  for item_row in select entry.value from jsonb_array_elements(requested_items) as entry(value)
  loop
    item_quantity := (item_row.value ->> 'quantity')::integer;
    if item_quantity not between 1 and 25 then
      raise exception using errcode = '22023', message = 'Invalid item quantity';
    end if;
    select p.id, p.name, p.price_cents into product_row
    from public.products as p
    where p.id = (item_row.value ->> 'productId')::bigint
      and p.active
    for share;
    if not found then
      raise exception using errcode = '22023', message = 'Product unavailable';
    end if;

    item_options := coalesce(item_row.value -> 'personalizations', '[]'::jsonb);
    if jsonb_typeof(item_options) <> 'array' or jsonb_array_length(item_options) > 8 then
      raise exception using errcode = '22023', message = 'Invalid personalizations';
    end if;
    item_modifier := 0;
    has_size := false;
    for option_row in select entry.value from jsonb_array_elements(item_options) as entry(value)
    loop
      option_name := btrim(coalesce(option_row.value ->> 'name', ''));
      option_value := btrim(coalesce(option_row.value ->> 'value', ''));
      if option_name = 'Tamaño' then
        if has_size or option_value not in ('regular', 'grande') then
          raise exception using errcode = '22023', message = 'Invalid size personalization';
        end if;
        has_size := true;
        option_price := case when option_value = 'grande' then 200 else 0 end;
      elsif option_name = 'Extra' then
        option_price := case option_value
          when 'Queso extra' then 100
          when 'Tocino extra' then 150
          when 'Huevo frito' then 100
          when 'Aros de cebolla' then 120
          else null
        end;
        if option_price is null then
          raise exception using errcode = '22023', message = 'Invalid extra personalization';
        end if;
      elsif option_name = 'Sin' and option_value in ('Cebolla', 'Pickles') then
        option_price := 0;
      else
        raise exception using errcode = '22023', message = 'Invalid personalization';
      end if;
      item_modifier := item_modifier + option_price;
    end loop;
    if exists (
      select 1
      from jsonb_array_elements(item_options) as entry(value)
      group by lower(entry.value ->> 'name'), lower(entry.value ->> 'value')
      having count(*) > 1
    ) then
      raise exception using errcode = '22023', message = 'Duplicate personalization';
    end if;
    subtotal := subtotal + (product_row.price_cents + item_modifier) * item_quantity;
  end loop;

  tax := round(subtotal * 0.08)::bigint;
  service := 50;
  total := subtotal + tax + service;
  new_order_code := 'BF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  if requested_order_type = 'delivery' then
    select u.id into driver_id
    from public.users as u
    where u.role_id = 'delivery' and u.active
    order by u.id
    limit 1;
  end if;

  insert into public.orders (code, created_by, cliente_id, repartidor_id, order_type, status)
  values (new_order_code, actor_id, customer_id, driver_id, requested_order_type, 'pending')
  returning id into new_order_id;

  insert into public.order_financials (order_id, subtotal_cents, tax_cents, service_cents, total_cents)
  values (new_order_id, subtotal, tax, service, total);
  insert into public.order_payments (order_id, payment_method)
  values (new_order_id, requested_payment_method);

  for item_row in select entry.value from jsonb_array_elements(requested_items) as entry(value)
  loop
    item_quantity := (item_row.value ->> 'quantity')::integer;
    select p.id, p.name, p.price_cents into product_row
    from public.products as p
    where p.id = (item_row.value ->> 'productId')::bigint and p.active;
    item_options := coalesce(item_row.value -> 'personalizations', '[]'::jsonb);
    item_modifier := 0;
    for option_row in select entry.value from jsonb_array_elements(item_options) as entry(value)
    loop
      option_name := btrim(option_row.value ->> 'name');
      option_value := btrim(option_row.value ->> 'value');
      option_price := case
        when option_name = 'Tamaño' and option_value = 'grande' then 200
        when option_name = 'Extra' and option_value = 'Queso extra' then 100
        when option_name = 'Extra' and option_value = 'Tocino extra' then 150
        when option_name = 'Extra' and option_value = 'Huevo frito' then 100
        when option_name = 'Extra' and option_value = 'Aros de cebolla' then 120
        else 0
      end;
      item_modifier := item_modifier + option_price;
    end loop;
    item_unit_price := product_row.price_cents + item_modifier;

    insert into public.order_items (order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
    values (new_order_id, product_row.id, product_row.name, item_quantity, item_unit_price, item_unit_price * item_quantity)
    returning id into item_line_id;

    for option_row in select entry.value from jsonb_array_elements(item_options) as entry(value)
    loop
      option_name := btrim(option_row.value ->> 'name');
      option_value := btrim(option_row.value ->> 'value');
      option_price := case
        when option_name = 'Tamaño' and option_value = 'grande' then 200
        when option_name = 'Extra' and option_value = 'Queso extra' then 100
        when option_name = 'Extra' and option_value = 'Tocino extra' then 150
        when option_name = 'Extra' and option_value = 'Huevo frito' then 100
        when option_name = 'Extra' and option_value = 'Aros de cebolla' then 120
        else 0
      end;
      insert into public.personalizations (order_item_id, name, value, price_delta_cents)
      values (item_line_id, option_name, option_value, option_price);
    end loop;

    update public.inventory
    set quantity = quantity - item_quantity, updated_at = now()
    where product_id = product_row.id;
    insert into public.inventory_movements (product_id, changed_by, delta, reason)
    values (product_row.id, actor_id, -item_quantity, 'Reserva por pedido');
  end loop;

  if requested_order_type = 'delivery' then
    insert into public.delivery_info (order_id, customer_name, phone, address)
    values (new_order_id, delivery_name, delivery_phone, delivery_address);
  end if;

  insert into public.order_status_history (order_id, changed_by, old_status, new_status)
  values (new_order_id, actor_id, null, 'pending');

  return new_order_id;
end
$$;

create function public.update_delivery_info(
  target_order_id bigint,
  delivery_name text,
  delivery_phone text,
  delivery_address text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  actor_id bigint := public.current_app_user_id();
  actor_role text := public.current_app_role();
begin
  select * into order_row
  from public.orders
  where id = target_order_id
  for update;
  if not found or order_row.order_type <> 'delivery' or actor_id is null or not coalesce(
    actor_role = 'admin'
    or (actor_role = 'customer' and order_row.cliente_id = actor_id)
    or (actor_role = 'cashier' and order_row.created_by = actor_id),
    false
  ) then
    raise exception using errcode = 'P0002', message = 'Delivery order not found';
  end if;
  if order_row.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'Delivery details are locked';
  end if;
  if length(btrim(delivery_name)) not between 1 and 100
    or delivery_phone !~ '^[+0-9 ()-]{7,24}$'
    or length(btrim(delivery_address)) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'Invalid delivery details';
  end if;

  update public.delivery_info
  set customer_name = btrim(delivery_name),
      phone = btrim(delivery_phone),
      address = btrim(delivery_address)
  where order_id = target_order_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery details not found';
  end if;
end
$$;

create function public.update_order_status(target_order_id bigint, requested_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  actor_id bigint := public.current_app_user_id();
  actor_role text := public.current_app_role();
  allowed boolean := false;
  item_row record;
begin
  select * into order_row
  from public.orders
  where id = target_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if actor_role = 'delivery' and order_row.repartidor_id is distinct from actor_id then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not (
    (order_row.status = 'pending' and requested_status in ('preparing', 'cancelled'))
    or (order_row.status = 'preparing' and requested_status in ('ready', 'cancelled'))
    or (order_row.status = 'ready' and requested_status = 'out_for_delivery')
    or (order_row.status = 'out_for_delivery' and requested_status = 'delivered')
  ) then
    raise exception using errcode = 'P0001', message = 'Invalid status transition';
  end if;

  allowed :=
    (requested_status = 'cancelled' and (
      public.has_app_permission('orders:cancel') or actor_role = 'admin'
    ))
    or (requested_status in ('preparing', 'ready') and (
      public.has_app_permission('orders:status:kitchen') or actor_role = 'admin'
    ))
    or (requested_status in ('out_for_delivery', 'delivered') and (
      public.has_app_permission('orders:status:delivery') or actor_role = 'admin'
    ));
  if not allowed then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;

  update public.orders set status = requested_status where id = target_order_id;
  insert into public.order_status_history (order_id, changed_by, old_status, new_status)
  values (target_order_id, actor_id, order_row.status, requested_status);

  if requested_status = 'cancelled' then
    for item_row in
      select oi.product_id, sum(oi.quantity)::integer as quantity
      from public.order_items as oi
      where oi.order_id = target_order_id
      group by oi.product_id
      order by oi.product_id
    loop
      update public.inventory
      set quantity = quantity + item_row.quantity, updated_at = now()
      where product_id = item_row.product_id;
      insert into public.inventory_movements (product_id, changed_by, delta, reason)
      values (item_row.product_id, actor_id, item_row.quantity, 'Reversión por cancelación');
    end loop;
  end if;
end
$$;

create function public.assign_delivery_driver(target_order_id bigint, target_driver_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_app_permission('orders:assign') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  if not exists (
    select 1 from public.users
    where id = target_driver_id and role_id = 'delivery' and active
  ) then
    raise exception using errcode = '22023', message = 'Invalid delivery driver';
  end if;
  update public.orders
  set repartidor_id = target_driver_id
  where id = target_order_id
    and order_type = 'delivery'
    and status in ('pending', 'preparing', 'ready');
  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery order not found';
  end if;
end
$$;

create function public.dashboard_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_app_permission('dashboard:read') then
    raise exception using errcode = '42501', message = 'Not authorized';
  end if;
  return (
    select jsonb_build_object(
      'orderCount', (select count(*) from public.orders),
      'todaySalesCents', (
        select coalesce(sum(f.total_cents), 0)
        from public.orders as o
        join public.order_financials as f on f.order_id = o.id
        where (o.created_at at time zone 'America/La_Paz')::date =
          (now() at time zone 'America/La_Paz')::date
      ),
      'inProgress', (
        select count(*) from public.orders
        where status in ('pending', 'preparing', 'ready', 'out_for_delivery')
      ),
      'lowStock', (
        select count(*)
        from public.inventory as i
        join public.products as p on p.id = i.product_id
        where p.active and i.quantity <= i.low_stock_threshold
      )
    )
  );
end
$$;

revoke all on function public.create_product(text, text, text, bigint, integer, text) from public;
revoke all on function public.update_product(bigint, text, text, text, bigint) from public;
revoke all on function public.deactivate_product(bigint) from public;
revoke all on function public.adjust_inventory(bigint, integer, text) from public;
revoke all on function public.create_order(text, text, jsonb, jsonb, bigint) from public;
revoke all on function public.update_delivery_info(bigint, text, text, text) from public;
revoke all on function public.update_order_status(bigint, text) from public;
revoke all on function public.assign_delivery_driver(bigint, bigint) from public;
revoke all on function public.dashboard_metrics() from public;

grant execute on function public.create_product(text, text, text, bigint, integer, text) to authenticated;
grant execute on function public.update_product(bigint, text, text, text, bigint) to authenticated;
grant execute on function public.deactivate_product(bigint) to authenticated;
grant execute on function public.adjust_inventory(bigint, integer, text) to authenticated;
grant execute on function public.create_order(text, text, jsonb, jsonb, bigint) to authenticated;
grant execute on function public.update_delivery_info(bigint, text, text, text) to authenticated;
grant execute on function public.update_order_status(bigint, text) to authenticated;
grant execute on function public.assign_delivery_driver(bigint, bigint) to authenticated;
grant execute on function public.dashboard_metrics() to authenticated;
