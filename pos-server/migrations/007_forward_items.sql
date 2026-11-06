-- รายการใน FloCafe ที่ออเดอร์ QR แต่ละใบสร้างขึ้น → connector ใช้ติดตามสถานะครัวกลับไปให้ลูกค้าเห็น
alter table pos_forward add column pos_item_ids text[] not null default '{}';
