-- Cost-rate seeds for the fixed-demo lines/parts. In the upstream installer
-- these are generated from the line template YAMLs; vendored verbatim here
-- (values captured from a v1.4.0 --fixed-demo deployment) so a fresh compose
-- boot serves the same rates through the costs-api dataflow.
INSERT INTO part_scrap_costs (part_number, cost_per_unit, description) VALUES
  ('BRACKET-SS-A', 15.00, 'Stainless steel mounting bracket - 3mm 304SS'),
  ('FRAME-WELD-A', 180.00, 'Car body frame - sedan/hatchback platform'),
  ('FRAME-WELD-B', 150.00, 'Truck body frame - heavy-duty platform'),
  ('PANEL-AL-B', 32.00, 'Aluminum enclosure panel - 2mm 5052-H32'),
  ('THT-MAIN-A', 22.00, 'Mainboard - high-power motor controller'),
  ('THT-SENS-B', 18.00, 'Sensor board - multi-channel analog input module'),
  ('WIN-LRG-B', 85.00, 'Large panorama window - 240x180cm triple-glazed'),
  ('WIN-STD-A', 45.00, 'Standard window - 120x100cm double-glazed')
ON CONFLICT (part_number) DO NOTHING;

INSERT INTO line_downtime_costs (line_name, cost_per_hour) VALUES
  ('automotive-welding', 800.00),
  ('electronics-through-hole', 350.00),
  ('metal-parts-fabrication', 500.00),
  ('window-frame', 300.00)
ON CONFLICT (line_name) DO NOTHING;
