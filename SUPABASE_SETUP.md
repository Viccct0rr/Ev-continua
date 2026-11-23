# Configuración e integración Supabase — BurgerFlow

## Estado comprobado

- Entorno: Windows x64, Node.js `v24.19.0`, npm `11.17.0`.
- Supabase CLI `3.0.0` está instalada como dependencia de desarrollo; `@supabase/supabase-js` `2.119.0` está instalado.
- La CLI está autenticada localmente. El proyecto `BurgerFlow` (`vwobduocgjcreulhebxb`, región `sa-east-1`) está activo y enlazado.
- La configuración remota se sincronizó con `supabase config push --yes`: solo se cambió `auth.enable_signup` de `true` a `false`. Las diferencias de MFA, correo, pooler y Storage permanecieron intactas.
- Las migraciones `20261111000100`, `20261111000200` y `20261122000100` están aplicadas. La verificación confirma 14 tablas públicas con RLS, 17 políticas y permisos DML de `service_role` en las 14 tablas.
- `.env` está ignorado por Git. Los indicadores confirman que `SUPABASE_DB_PASSWORD` está presente y que las variables publishable/secret tienen los prefijos esperados; sus valores nunca se imprimieron. La lectura pública respondió HTTP 200; el secret se usó solo en servidor para preparar y limpiar las pruebas.
- La aplicación puede usar SQLite (predeterminado) o Supabase (`DATA_BACKEND=supabase`). El modo Supabase conserva SQLite para las sesiones Express; no importa ni borra registros de negocio locales.

## Archivos de integración

- `supabase/migrations/20261111000100_burgerflow_schema.sql`: tablas de negocio, roles/permisos, RLS e índices.
- `supabase/migrations/20261111000200_burgerflow_operations.sql`: RPCs para operaciones transaccionales y controladas por permiso.
- `supabase/migrations/20261122000100_service_role_api_access.sql`: migración aditiva aplicada; concede DML a `service_role` en las 14 tablas actuales y uso/lectura de secuencias.
- `supabase/seed.sql`: catálogo/inventario demostrativo, repetible sin sobrescribir cambios existentes.
- `backend/supabase-client.js`: inicialización del cliente publicable y del cliente administrativo de servidor.
- `backend/app.js`: autenticación Supabase, autorización por RPC/RLS y rutas de catálogo, inventario, pedidos, usuarios y métricas.
- `backend/server.js`: selección del backend mediante `DATA_BACKEND`.
- `.env.example`: plantilla sin credenciales reales.
- `docs/supabase-integration/ANALISIS.md`: correspondencia entre PDF, modelo, RLS y aplicación.
- `docs/supabase-integration/CHECKLIST.md`: evidencia y tareas pendientes.
- `supabase/test-baseline.sql`: conteos agregados de solo lectura antes/después de pruebas.
- `scripts/supabase-remote-smoke.js`: pruebas de la API remota con sesiones Auth normales y limpieza de fixtures.

## Variables locales

Crear `.env` desde `.env.example` y sustituir los marcadores **localmente**:

```dotenv
DATA_BACKEND=sqlite
SUPABASE_URL=https://vwobduocgjcreulhebxb.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_<clave-del-proyecto>
SUPABASE_SECRET_KEY=sb_secret_<clave-secreta-del-servidor>
SUPABASE_DB_PASSWORD=<contraseña-de-la-base-remota>
```

La clave publishable identifica el proyecto; no concede acceso por sí sola y se usa desde Express. `SUPABASE_SECRET_KEY` se limita al servidor para Auth Admin y operaciones de servicio; nunca debe llegar al navegador. Las operaciones de autorización de la aplicación se validan con sesiones Auth normales y sus JWT. `SUPABASE_DB_PASSWORD` es necesaria para las operaciones CLI de base de datos y el backend la elimina de su entorno al arrancar. No publiques `.env`, no pegues estos valores en el chat y no reutilices una clave `service_role` legacy. `.gitignore` excluye `.env` y variantes locales. Mantén `DATA_BACKEND=sqlite` como predeterminado.

Para iniciar:

```powershell
npm.cmd start
```

Con `DATA_BACKEND=sqlite` (valor predeterminado) se conserva el comportamiento previo y la inicialización de datos locales. Con `DATA_BACKEND=supabase`, la API usa Supabase Auth y PostgreSQL; el servidor local de sesiones sigue en SQLite.

## Estado y verificación de migraciones

Las dos migraciones originales siguen aplicadas y no se reaplicaron. La migración nueva `20261122000100_service_role_api_access.sql` también se aplicó con autorización para habilitar el acceso del rol server-only. Para comprobar historial, tablas, RLS y grants:

```powershell
node scripts/supabase-cli.js migration list --remote
node scripts/supabase-cli.js db query --remote --read-only --file supabase/verify-schema.sql
```

No se requiere Docker para las consultas de verificación.

Verificación del 2026-11-22: `npx.cmd supabase projects list` confirmó BurgerFlow activo y enlazado en `sa-east-1`; `migration list --remote` confirmó las tres migraciones aplicadas. `verify-schema.sql` devolvió 14 tablas con RLS, 17 políticas y grants DML de `service_role` activos en las 14 tablas. El baseline final es `auth_users=0`, `users_by_role={}`, `products=11`, `inventory_items=11` y `orders=0`; las filas de catálogo e inventario corresponden a la semilla ficticia autorizada.

## Alta inicial de administrador y cuentas

Como las altas públicas de Auth están deshabilitadas, el primer administrador debe provisionarse manualmente después de aplicar el esquema:

1. En Supabase Dashboard → **Authentication → Users**, crear una cuenta de correo/contraseña y confirmar la dirección según la política del proyecto.
2. Copiar el UUID de esa cuenta y ejecutar en SQL Editor, sustituyendo los tres marcadores localmente:

```sql
insert into public.users (auth_user_id, name, email, role_id)
values (
  '<UUID-de-auth.users>'::uuid,
  '<Nombre del administrador>',
  lower('<correo de Auth>'),
  'admin'
);
```

3. Iniciar sesión desde BurgerFlow. Las demás cuentas se crean en la interfaz administrativa mediante `/api/users`; el backend asigna el rol y enlaza Auth con el perfil. Los usuarios SQLite existentes no se convierten automáticamente: hay que provisionar sus credenciales en Auth y restablecerlas.
4. El flujo POS existente no envía `customerId`; para los pedidos de cajero/admin, `create_order` conserva la convención local y busca un cliente activo `cliente@burgerflow.local`. Crear esa cuenta como rol `customer` desde la administración o adaptar explícitamente el flujo de caja antes del uso real.

## Semilla y evidencia de prueba remota

La semilla contiene solo productos e inventario ficticios y usa `ON CONFLICT DO NOTHING`. No se ejecuta automáticamente con `db push`. Se cargó con autorización del usuario; el baseline confirmó 11 productos y 11 filas de inventario, y la API pública respondió HTTP 200 con los 11 productos activos. Una repetición del comando no sobrescribe registros existentes.

El mismo requisito de cargar la contraseña desde `.env` se aplica al historial y a la carga de semillas:

```powershell
node scripts/supabase-cli.js db query --remote --file supabase/seed.sql --yes
```

Los indicadores locales confirman claves con formato esperado; no se muestran valores. Una ejecución completa de `node scripts/supabase-remote-smoke.js --run`, antes de cargar el catálogo, terminó con `success=true` y `cleanup=test-records-and-auth-users-removed`. Probó Auth y permisos con sesiones JWT normales de admin, cajero, cocina, dos repartidores y dos clientes; además cubrió productos, inventario, pedidos/líneas, datos de entrega, pagos, entradas inválidas, denegaciones, persistencia tras reinicio y reasignación A→B. Tras reasignar, A recibió 404 sin datos personales y B pudo leer la dirección. Después de cargar la semilla, dos intentos completos iniciales encontraron HTTP 500 intermitentes en solicitudes que esperaban 400/403; una cuenta Auth cuya eliminación automática falló se limpió manualmente usando únicamente la etiqueta aleatoria de esa ejecución. La ejecución completa final con el catálogo presente terminó `success=true` y limpió sus fixtures; las validaciones negativas respondieron con los estados esperados. El baseline final confirmó cero usuarios Auth/perfiles y pedidos, y 11 productos/inventarios.

La migración `20261122000100_service_role_api_access.sql` otorga DML explícito a `service_role` en las 14 tablas actuales y uso/lectura de secuencias; no añade permisos predeterminados para objetos futuros ni cambia RLS. La clave secreta se usa solo en el servidor para administrar fixtures; las verificaciones de autorización usan JWT normales. El smoke no cambia `DATA_BACKEND`.

`npm.cmd test` pasó 13/13 pruebas locales; `node --check` pasó para seis archivos, incluidos `backend/app.test.js` y los archivos de backend/CLI anteriores. `git diff --check` no reportó errores; solo señaló el aviso de LF/CRLF en `supabase/config.toml`.

No se reutilizó la clave legacy `service_role` mencionada en el historial. La semilla cargada contiene 11 productos y 11 filas de inventario ficticios; `DATA_BACKEND=sqlite` sigue como valor predeterminado.

## Comandos útiles

```powershell
npx.cmd supabase --version
npx.cmd supabase projects list
npx.cmd supabase config diff
npx.cmd supabase migration list --remote
npx.cmd supabase db push --dry-run --remote
node scripts/supabase-cli.js db query --remote --read-only --file supabase/verify-schema.sql
node scripts/supabase-cli.js db query --remote --read-only --file supabase/test-baseline.sql
npm.cmd test
node scripts/supabase-remote-smoke.js --run
```
