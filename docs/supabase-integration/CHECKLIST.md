# Integración BurgerFlow con Supabase

## Estado

**Verificado el 2026-11-22.** `BurgerFlow` (`vwobduocgjcreulhebxb`, `sa-east-1`) sigue `ACTIVE_HEALTHY` y enlazado; están aplicadas `20261111000100`, `20261111000200` y `20261122000100`; hay 14 tablas con RLS y 17 políticas. `.env` contiene claves con los prefijos esperados, `SUPABASE_DB_PASSWORD` está presente, `.env` está ignorado por Git y `DATA_BACKEND=sqlite`. Solo se registraron indicadores, nunca valores de claves.

La suite remota completa terminó `success=true` y `cleanup=test-records-and-auth-users-removed` antes de cargar la semilla. Usó sesiones Auth normales de admin, cajero, cocina, dos repartidores y dos clientes; probó CRUD, entradas inválidas, accesos permitidos/denegados, reasignación A→B y persistencia tras reiniciar la app. Luego, por instrucción del usuario, se cargaron 11 productos ficticios y sus 11 filas de inventario. La API pública respondió HTTP 200 y mostró los 11 productos.

Dos repeticiones completas iniciales con la semilla presente encontraron HTTP 500 intermitentes en operaciones que esperaban 400/403. La primera limpió automáticamente sus fixtures; en la segunda falló una eliminación Auth y se limpió manualmente solo esa etiqueta. Después, una ejecución completa adicional con la semilla terminó `success=true` y `cleanup=test-records-and-auth-users-removed`; todas las comprobaciones esperadas de 400/403/404 pasaron. El baseline remoto final es `auth_users=0`, `users_by_role={}`, `products=11`, `inventory_items=11` y `orders=0`; no quedan archivos temporales de limpieza.

## Checklist de ejecución

- [x] Revisar el proyecto y validar el PDF. Evidencia: `package.json`, rutas de `backend/app.js`, migraciones SQLite y PDF de 8 páginas `.docs/ER-CRUD/analisis-entidad-crud-seguridad.VictorVargas.pdf.pdf`.
- [x] Documentar el modelo y su correspondencia con la aplicación. Evidencia: [`ANALISIS.md`](ANALISIS.md), contrastado con el PDF, migraciones SQLite y endpoints.
- [x] Confirmar destino remoto. Evidencia de esta ejecución: `npx.cmd supabase projects list` devolvió `BurgerFlow`, ref `vwobduocgjcreulhebxb`, región `sa-east-1`, `ACTIVE_HEALTHY`, `linked=true`.
- [x] Confirmar historial sin reaplicar migraciones anteriores. Evidencia: `node scripts/supabase-cli.js migration list --remote` confirma `20261111000100`, `20261111000200` y la nueva `20261122000100` aplicadas.
- [x] Verificar esquema, RLS y privilegios SQL. Evidencia: `node scripts/supabase-cli.js db query --remote --read-only --file supabase/verify-schema.sql` devolvió 14 tablas con `rls=true`, 17 políticas y SELECT/INSERT/UPDATE/DELETE para `service_role` en las 14 tablas.
- [x] Comprobar limpieza de fixtures y estado del catálogo. Evidencia: tras las pruebas se verificó `auth_users=0`, `users_by_role={}`, `products=11`, `inventory_items=11` y `orders=0`; los 11 productos/inventarios son la semilla autorizada, no datos de prueba.
- [x] Verificar permisos efectivos con sesiones Auth normales. El ejecutor confirmó permisos por rol con JWT/sesiones para admin, cashier, kitchen, delivery A/B y customer A/B; incluye denegaciones y aislamiento entre usuarios.
- [x] Configurar la política de altas de Auth. Evidencia: `supabase config diff` mostró un único cambio administrado; `supabase config push --yes` confirmó `auth.enable_signup=false`. El resto de diferencias remotas quedó sin modificar.
- [x] Configurar el SDK y las variables de entorno sin exponer claves. Evidencia: indicadores locales confirman ambas claves con prefijos/formato esperado, password de base presente, `.env` ignorado por Git y `DATA_BACKEND=sqlite`; la clave publishable obtuvo HTTP 200 en una lectura pública.
- [x] Integrar y comprobar cada operación CRUD requerida en la API remota.
  - [x] Productos — rutas Express conectadas a RPC de creación/edición/baja lógica y lectura de catálogo.
  - [x] Inventario — lectura y ajuste auditado mediante RPC.
  - [x] Pedidos/líneas — creación transaccional vía RPC, lecturas con RLS, estados y reasignación mediante RPC.
  - [x] Datos de entrega — actualización autorizada por propietario/creador/admin; lectura RLS por dueño o repartidor actualmente asignado.
  - [x] Pagos — método de pago separado de importes para limitar la lectura a admin/cajero.
  - [x] Usuarios — Auth Admin + perfil, alta y activación/desactivación en backend; requiere `SUPABASE_SECRET_KEY` solo en servidor.
  - [x] Roles, permisos, historial y movimientos — catálogo seed de roles/permisos y escritura transaccional de auditoría; sin modificación/eliminación interactiva.
  - [x] Prueba remota completa anterior a la semilla: productos crear/leer/editar/baja lógica; inventario ajustar y validar negativo; pedidos/líneas, estados, pagos y delivery; entradas inválidas; acceso por roles.
  - [x] Aislamiento de delivery A/B: tras reasignar, A recibió 404 sin datos personales y B leyó la dirección asignada.
  - [x] Persistencia: producto, pedido/líneas/estado/delivery e inventario sobrevivieron al reinicio del servidor de prueba.
- [x] Verificar CRUD, persistencia y permisos de la aplicación contra Cloud con sesiones Auth normales. `npm.cmd test` pasó 13/13 localmente; el smoke remoto completo pasó antes de cargar la semilla y volvió a pasar en una ejecución completa posterior con la semilla presente. Se probaron las sesiones por rol, CRUD, entradas inválidas, permisos, delivery A→B y persistencia tras reiniciar; la última ejecución limpió sus fixtures.
- [x] Ejecutar el smoke remoto completo con el catálogo sembrado. Dos intentos iniciales tuvieron HTTP 500 intermitentes en solicitudes que esperaban 400/403; la ejecución completa posterior pasó todas las comprobaciones y dejó el baseline limpio.
- [x] Aplicar `20261122000100_service_role_api_access.sql`. El dry-run mostró solo esta migración pendiente; se aplicó después de autorización explícita. No se reaplicaron las dos migraciones anteriores. La semilla ficticia se cargó después, con autorización del usuario.
- [x] Documentar ejecución y evidencia. Evidencia: [`ANALISIS.md`](ANALISIS.md), [`SUPABASE_SETUP.md`](../../SUPABASE_SETUP.md), este checklist y `supabase/verify-schema.sql`.

## Decisiones y preservación de datos

- Se eligió Supabase Auth con perfiles `public.users` vinculados a `auth.users.id`; los roles se asignan desde el backend administrativo, nunca desde metadata enviada por el navegador.
- No se trasladarán hashes bcrypt ni usuarios/datos SQLite automáticamente. La base local y sus datos siguen intactos; en modo Supabase SQLite conserva el esquema local y las sesiones de Express.
- `DATA_BACKEND=sqlite` mantiene el comportamiento existente. Cambiar a `DATA_BACKEND=supabase` activa la autenticación y operaciones remotas.
- Los pedidos se crean y cancelan en funciones PostgreSQL transaccionales para mantener inventario, líneas, personalizaciones e historial consistentes.
- El acceso a cocina se limita a pedidos activos; el contacto de entrega y el método de pago tienen políticas independientes.
- Los pedidos de cocina no incluyen contacto, totales agregados ni método de pago. El DTO conserva precios de línea tal como los mostraba la API SQLite.
- No se reutilizó ni guardó la clave legacy `service_role` mencionada en el historial.
- `scripts/supabase-remote-smoke.js` exige que no haya usuarios Auth, perfiles ni pedidos previos; permite el catálogo sembrado. Crea fixtures con etiqueta única, ejerce la app mediante sesiones Auth normales y elimina solo los fixtures de la ejecución. Tras dos repeticiones iniciales con HTTP 500 intermitentes, una ejecución completa adicional con semilla terminó correctamente. El baseline actual confirma que no quedan cuentas ni pedidos de prueba y conserva las 11 filas del catálogo/inventario autorizado.

## Cierre

Una ejecución completa previa a la semilla y una ejecución completa posterior pasaron con sesiones autenticadas normales y verificaron Auth, CRUD, persistencia y permisos. La semilla ficticia se cargó por instrucción del usuario y se verificó por SQL y API; conserva 11 productos y 11 filas de inventario. Dos intentos posteriores iniciales tuvieron HTTP 500 intermitentes, pero la ejecución final pasó las validaciones con 400/403/404 y limpió todas sus cuentas y registros. El baseline final está limpio salvo el catálogo ficticio. `DATA_BACKEND=sqlite` sigue como predeterminado. No se hizo commit.

## Siguiente acción al retomar

No crear ni enlazar otro proyecto, no volver a aplicar `20261111000100`, `20261111000200` ni `20261122000100`, y no volver a cargar la semilla como parte de las pruebas. Si se retoman las verificaciones, ejecutar primero los comandos de solo lectura de proyecto, migraciones, esquema y baseline; lanzar `node scripts/supabase-remote-smoke.js --run` solo si no hay usuarios Auth, perfiles ni pedidos previos. El catálogo de 11 productos/inventarios es intencional. Si reaparece el HTTP 500 intermitente, recoger el código/etapa sanitizados del smoke para diagnosticarlo antes de cambiar el esquema. Mantener `DATA_BACKEND=sqlite` como predeterminado.
