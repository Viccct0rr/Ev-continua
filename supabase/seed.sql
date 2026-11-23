insert into public.products (name, category, description, price_cents)
values
  ('Doble Flow Burger', 'Hamburguesas', 'Hamburguesa de demostración', 1250),
  ('Crispy Spicy Chicken', 'Hamburguesas', 'Pollo crujiente de demostración', 900),
  ('Vegan Classic Flow', 'Hamburguesas', 'Hamburguesa vegetal de demostración', 1100),
  ('Papas Clásicas (L)', 'Acompañamientos', 'Papas de demostración', 450),
  ('Flow Loaded Fries', 'Acompañamientos', 'Papas cargadas de demostración', 600),
  ('Bacon Blast Burger', 'Hamburguesas', 'Hamburguesa de demostración', 1450),
  ('Cheese Heaven', 'Hamburguesas', 'Hamburguesa de demostración', 1200),
  ('The Monster Burger', 'Hamburguesas', 'Hamburguesa de demostración', 1890),
  ('Classic Smash Burger', 'Hamburguesas', 'Hamburguesa de demostración', 1250),
  ('Spicy Chicken Sandwich', 'Hamburguesas', 'Sándwich de pollo de demostración', 900),
  ('Large Fries', 'Acompañamientos', 'Papas fritas de demostración', 450)
on conflict (name) do nothing;

insert into public.inventory (product_id, quantity, unit)
select p.id, seed.quantity, seed.unit
from (values
  ('Doble Flow Burger', 30, 'unidades'),
  ('Crispy Spicy Chicken', 20, 'unidades'),
  ('Vegan Classic Flow', 10, 'unidades'),
  ('Papas Clásicas (L)', 35, 'porciones'),
  ('Flow Loaded Fries', 18, 'porciones'),
  ('Bacon Blast Burger', 18, 'unidades'),
  ('Cheese Heaven', 22, 'unidades'),
  ('The Monster Burger', 8, 'unidades'),
  ('Classic Smash Burger', 18, 'unidades'),
  ('Spicy Chicken Sandwich', 15, 'unidades'),
  ('Large Fries', 30, 'porciones')
) as seed(name, quantity, unit)
join public.products as p on p.name = seed.name
on conflict (product_id) do nothing;
