select 'table' as kind, c.relname as name, 'rls=' || c.relrowsecurity::text as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'

union all

select 'grant' as kind,
       c.relname as name,
       'service_role_select=' || has_table_privilege('service_role', c.oid, 'SELECT')::text ||
       ';insert=' || has_table_privilege('service_role', c.oid, 'INSERT')::text ||
       ';update=' || has_table_privilege('service_role', c.oid, 'UPDATE')::text ||
       ';delete=' || has_table_privilege('service_role', c.oid, 'DELETE')::text as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'

union all

select 'policy' as kind,
       schemaname || '.' || tablename || '.' || policyname as name,
       'command=' || cmd || '; roles=' || array_to_string(roles, ',') as detail
from pg_policies
where schemaname = 'public'

order by kind, name;
