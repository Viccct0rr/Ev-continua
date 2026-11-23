-- The server-only secret API key maps to service_role. Grant only the DML
-- needed to provision and clean up BurgerFlow records through the Data API.
-- Authenticated application requests still use their normal JWTs and RLS.
grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.delivery_info,
  public.inventory,
  public.inventory_movements,
  public.order_financials,
  public.order_items,
  public.order_payments,
  public.order_status_history,
  public.orders,
  public.permissions,
  public.personalizations,
  public.products,
  public.role_permissions,
  public.roles,
  public.users
to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Future tables require explicit grants in the migration that creates them.
