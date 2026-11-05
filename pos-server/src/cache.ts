export interface MenuEntry {
  exp: number;
  body: unknown;
}

/** cache เมนูต่อร้าน (30 วินาที) ล้างเมื่อได้รับ NOTIFY 'menu.changed' */
export const menuCache = new Map<string, MenuEntry>();
export const MENU_TTL_MS = 30_000;
