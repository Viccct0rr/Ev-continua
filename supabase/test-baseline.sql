select jsonb_build_object(
  'users_by_role', (
    select coalesce(jsonb_object_agg(role_id, n), '{}'::jsonb)
    from (select role_id, count(*) as n from public.users group by role_id) as role_counts
  ),
  'products', (select count(*) from public.products),
  'inventory_items', (select count(*) from public.inventory),
  'orders', (select count(*) from public.orders),
  'auth_users', (select count(*) from auth.users)
) as baseline;
