'use client';

import axios, { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import {
  ChefHat,
  LayoutGrid,
  Minus,
  Plus,
  Send,
  ShoppingCart,
  Smartphone,
  SquarePen,
  Trash2,
  UserRound,
  UtensilsCrossed,
  MoreVertical,
  ArrowLeftRight,
  Merge,
} from 'lucide-react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';
import { FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parsePhone } from '@/lib/phone';
import { getLanguageDirection, getLanguageLocale, useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { StoreClock } from '@/components/layout/StoreClock';
import {
  OrderedItemList,
  OrderedItemsScreen,
  TableKitchenSummary,
  type OrderedItem,
} from '@/components/server-app/OrderedItems';
import {
  TableTransferDialog,
  type TransferMode,
  type TransferTable,
} from '@/components/server-app/TableTransferDialog';
import { toastApiError } from '@/lib/api-error';
import { formatCurrencyForTenant } from '@/lib/countries';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { usePosSettingsStore } from '@/store/pos-settings';
import { printerService } from '@/lib/printer/PrinterService';
import { generateCartItemId } from '@/lib/cart-identity';
import { productNeedsCustomizer, scannedVariantNeedsCustomizer } from '@/lib/product-variants';
import AddonModal from '@/components/pos/AddonModal';
import ProductGrid from '@/components/pos/ProductGrid';
import type {
  Order as FullOrder,
  Product,
  Addon,
  CartItem,
  Category,
  ProductVariant,
} from '@/lib/types';
import { cartItemToOrderItem } from '@/lib/cart-order-item';

type User = { id: string; name: string; email: string; role: string };
type Table = {
  id: string;
  name?: string;
  number?: string;
  status?: string;
  owner_user_id?: string | null;
  activeOrder?: Order | null;
  current_order?: Order | null;
};
type OrderItem = {
  id: number;
  product_id?: string | number;
  created_at?: string;
  product_name: string;
  quantity: number;
  status: string;
  special_instructions?: string | null;
  variant_selection?: unknown;
  service_change?: string | null;
  served_confirmed_at?: string | null;
};
type Order = {
  id: number;
  order_number: string;
  table_id?: string | null;
  status: string;
  items?: OrderItem[];
  customer?: { id: string; name: string; phone?: string } | null;
  /** Menu lines still waiting or cooking, ready to serve, and served. */
  kitchen_counts?: { waiting: number; ready: number; served: number };
};
type DraftLine = CartItem;
type ServerAppInfo = {
  country: string;
  currency: string;
  currency_symbol: string;
  currency_position: 'prefix' | 'suffix';
  currency_fraction_digits: number;
  timezone?: string;
  server_time?: string;
};


const TOKEN_KEY = 'flocafe:server-app-token';
const LIVE_REFRESH_MS = 5000;

const subscribeToNothing = () => () => {};

// Tablets and computers: the current ticket sits beside the menu.
const WIDE_QUERY = '(min-width: 768px)';
function subscribeToWide(onChange: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function createApi(): AxiosInstance {
  const api = axios.create({ baseURL: window.location.origin, timeout: 10000 });
  api.interceptors.request.use((config) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      const sentAuth = error.config?.headers?.Authorization;
      const currentToken = localStorage.getItem(TOKEN_KEY);
      if (error.response?.status === 401 && currentToken && sentAuth === `Bearer ${currentToken}`) {
        localStorage.removeItem(TOKEN_KEY);
      }
      return Promise.reject(error);
    },
  );
  return api;
}

function money(value: number | string, regional: ServerAppInfo | null) {
  return formatCurrencyForTenant(
    Number(value || 0),
    regional?.country || '',
    regional?.currency || '',
  );
}

type SendSnapshot = {
  tableId: string;
  tableName: string | undefined;
  orderId: number | null;
  orderCustomer: Order['customer'] | null;
  existingItemIds: Set<number>;
  draftLines: DraftLine[];
  customerName: string;
  customerPhone: string;
  orderNotes: string;
};

function sendAttemptSignature(
  tableId: string,
  draft: DraftLine[],
  customerName: string,
  customerPhone: string,
  orderNotes: string,
): string {
  const items = draft.map((line) => `${line.id}:${line.quantity}`).join('|');
  return `${tableId}|${items}|${customerName.trim()}|${customerPhone.trim()}|${orderNotes.trim()}`;
}

/** Staff who own tables see only those; everyone else sees every table. Ownership never restricts ordering. */
function ownedOrAllTables<T extends { owner_user_id?: string | null }>(
  tables: T[],
  userId: string | undefined,
): T[] {
  const owned = userId ? tables.filter((table) => table.owner_user_id === userId) : [];
  return owned.length > 0 ? owned : tables;
}

/** A table QR opens this app with `?table=<id>`; otherwise the first table the staff member sees is selected. */
/** A table named in the link (`?table=`); staff otherwise pick the table for every order. */
function pickLinkedTable<T extends { id: string }>(tables: T[]): T | undefined {
  if (typeof window === 'undefined') return undefined;
  const wanted = new URLSearchParams(window.location.search).get('table');
  return wanted ? tables.find((table) => table.id === wanted) : undefined;
}

export default function ServerStandalonePage() {
  // Syncs tenant language preference from /api/server-app/info.
  useSyncServerLanguage('/api/server-app/info');
  const language = usePosSettingsStore((state) => state.language);
  const t = useTranslations('serverApp');
  const tAuth = useTranslations('auth');
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const tPos = useTranslations('pos');

  // Fall back to caller-supplied localized message for server-app errors without dotted error codes.
  const apiErrorT = (key: string): string => key;
  const api = useMemo(() => (typeof window !== 'undefined' ? createApi() : null), []);
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [orderedItemsOpen, setOrderedItemsOpen] = useState(false);
  const [ticketMenuOpen, setTicketMenuOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<TransferMode | null>(null);
  const [transferring, setTransferring] = useState(false);
  const isWide = useSyncExternalStore(
    subscribeToWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
  useEffect(() => {
    document.documentElement.classList.add('theme-server-app');
    return () => document.documentElement.classList.remove('theme-server-app');
  }, []);
  // undefined while rendering on the server; null when the address carries no QR table.
  const guestTableId = useSyncExternalStore(
    subscribeToNothing,
    () => new URLSearchParams(window.location.search).get('table'),
    () => undefined,
  );
  const [guestTable, setGuestTable] = useState<{ id: string; name: string } | null>(null);
  const [guestChecked, setGuestChecked] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const guestAttemptRef = useRef<{ signature: string; key: string } | null>(null);
  const [regional, setRegional] = useState<ServerAppInfo | null>(null);

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [orderLoadedTableId, setOrderLoadedTableId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [orderNotes, setOrderNotes] = useState('');
  const [addonModalProduct, setAddonModalProduct] = useState<Product | null>(null);
  const [addonModalQuantity, setAddonModalQuantity] = useState(1);
  const [addonModalVariant, setAddonModalVariant] = useState<ProductVariant | null>(null);
  const [editingDraftLine, setEditingDraftLine] = useState<DraftLine | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [, setCustomerMatch] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [, setCustomerSearched] = useState(false);
  const phoneDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const phoneAbortRef = useRef<AbortController | null>(null);
  const [sending, setSending] = useState(false);
  // Synchronous re-entry guard: `sending` state updates too late to stop a second click fired before the first render.
  const sendInFlightRef = useRef(false);
  // Nonce and frozen target snapshot for the pending send attempt, paired with a signature of what defines it.
  // Reused while retrying that exact same attempt so a lost create response cannot switch to append on retry.
  const sendAttemptRef = useRef<{
    signature: string;
    nonce: string;
    snapshot: SendSnapshot;
  } | null>(null);
  const sendSeqRef = useRef(0);
  const addonModalSendSeqRef = useRef(0);
  const editingDraftSendSeqRef = useRef(0);
  const selectedTableIdRef = useRef('');
  // The linked table is applied once; after an order is sent the table is cleared for the next one.
  const linkedTableAppliedRef = useRef(false);
  const orderLoadedTableIdRef = useRef('');
  const orderLookupFailedRef = useRef(false);
  const orderLoadSeqRef = useRef(0);

  async function loadAll(options?: { allowWhileSending?: boolean }) {
    if (!api) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    const [categoriesRes, productsRes, tablesRes] = await Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ]);
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    setCategories(categoriesRes.data.categories || []);
    setProducts(productsRes.data.products || []);
    const loadedTables = tablesRes.data.tables || [];
    setTables(loadedTables);
    setTablesLoaded(true);
    const linkedTable = linkedTableAppliedRef.current ? undefined : pickLinkedTable(loadedTables);
    linkedTableAppliedRef.current = true;
    if (!selectedTableIdRef.current && linkedTable) {
      selectedTableIdRef.current = linkedTable.id;
      setSelectedTableId(linkedTable.id);
    }
  }

  function cancelPendingCustomerLookup() {
    clearTimeout(phoneDebounceRef.current);
    phoneAbortRef.current?.abort();
  }

  function fetchTableOrder(tableId: string) {
    return api!.get('/api/orders', {
      params: {
        table_id: tableId,
        type: 'dine_in',
        status: 'pending,preparing,ready,served',
        per_page: 1,
      },
    });
  }

  /** Picks up changes made elsewhere (payments at the POS, other staff) without disturbing the cart. */
  async function refreshLive() {
    if (!api || sendInFlightRef.current) return;
    const tableId = selectedTableIdRef.current;
    const loadSeq = orderLoadSeqRef.current;
    const orderLoaded = Boolean(tableId) && orderLoadedTableIdRef.current === tableId;
    const [tablesRes, orderRes] = await Promise.all([
      api.get('/api/tables', { params: { active: 'true' } }),
      orderLoaded ? fetchTableOrder(tableId) : Promise.resolve(null),
    ]);
    if (sendInFlightRef.current) return;
    const keepIfSame = <T,>(next: T) => (prev: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    setTables(keepIfSame<Table[]>(tablesRes.data.tables || []));
    if (orderRes && loadSeq === orderLoadSeqRef.current && selectedTableIdRef.current === tableId) {
      setCurrentOrder(keepIfSame<Order | null>(orderRes.data.orders?.[0] || null));
    }
  }

  async function loadOrder(tableId: string, options?: { allowWhileSending?: boolean }) {
    if (!api || !tableId) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    const loadSeq = ++orderLoadSeqRef.current;
    orderLookupFailedRef.current = false;
    if (!options?.allowWhileSending) {
      orderLoadedTableIdRef.current = '';
      setOrderLoadedTableId('');
    }
    cancelPendingCustomerLookup();
    try {
      const res = await fetchTableOrder(tableId);
      if (
        (sendInFlightRef.current && !options?.allowWhileSending) ||
        loadSeq !== orderLoadSeqRef.current ||
        selectedTableIdRef.current !== tableId
      ) {
        return;
      }
      const order = res.data.orders?.[0] || null;
      setCurrentOrder(order);
      const pendingAttempt =
        sendAttemptRef.current?.snapshot.tableId === tableId
          ? sendAttemptRef.current.snapshot
          : null;
      if (pendingAttempt) {
        setCustomerName(pendingAttempt.customerName);
        setCustomerPhone(pendingAttempt.customerPhone);
      } else if (order?.customer) {
        setCustomerName(order.customer.name || '');
        setCustomerPhone(order.customer.phone || '');
      } else {
        setCustomerName('');
        setCustomerPhone('');
      }
      setCustomerMatch(null);
      setCustomerSearched(false);
      orderLoadedTableIdRef.current = tableId;
      setOrderLoadedTableId(tableId);
    } catch (error) {
      if (
        !options?.allowWhileSending &&
        !sendInFlightRef.current &&
        loadSeq === orderLoadSeqRef.current &&
        selectedTableIdRef.current === tableId
      ) {
        setCurrentOrder(null);
        orderLoadedTableIdRef.current = '';
        setOrderLoadedTableId('');
        orderLookupFailedRef.current = true;
      }
      throw error;
    }
  }

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<ServerAppInfo>('/api/server-app/info')
      .then((infoResponse) => {
        if (!cancelled) setRegional(infoResponse.data);
        return api.get('/api/auth/me');
      })
      .then((res) => {
        if (!cancelled) setUser(res.data.user);
      })
      .catch((error) => {
        if (error.response?.status === 404) setDisabled(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!user || !api) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ])
      .then(([categoriesRes, productsRes, tablesRes]) => {
        if (cancelled || sendInFlightRef.current) return;
        setCategories(categoriesRes.data.categories || []);
        setProducts(productsRes.data.products || []);
        const loadedTables = tablesRes.data.tables || [];
        setTables(loadedTables);
        setTablesLoaded(true);
        const linkedTable = linkedTableAppliedRef.current ? undefined : pickLinkedTable(loadedTables);
        linkedTableAppliedRef.current = true;
        if (!selectedTableIdRef.current && linkedTable) {
          selectedTableIdRef.current = linkedTable.id;
          setSelectedTableId(linkedTable.id);
        }
      })
      .catch((error) => {
        if (error?.response?.status === 401) setUser(null);
        else toast.error(t('couldNotLoadData'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedTableId, user, t]);

  const refreshLiveRef = useRef(refreshLive);
  useEffect(() => {
    refreshLiveRef.current = refreshLive;
  });
  useEffect(() => {
    if (!user || !api) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      refreshLiveRef.current().catch(() => {});
    };
    const timer = setInterval(refresh, LIVE_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, user]);

  // A table QR opens the app as a guest bound to that one table until someone signs in.
  useEffect(() => {
    if (!api || user || !guestTableId || loading) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/guest/table', { params: { table_id: guestTableId } }),
      api.get('/api/guest/menu'),
    ])
      .then(([tableRes, menuRes]) => {
        if (cancelled) return;
        const table = tableRes.data.table as { id: string; name: string };
        setGuestTable(table);
        setTables([{ id: table.id, name: table.name }]);
        setTablesLoaded(true);
        setCategories(menuRes.data.categories || []);
        setProducts(menuRes.data.products || []);
        selectedTableIdRef.current = table.id;
        setSelectedTableId(table.id);
        orderLoadedTableIdRef.current = table.id;
        setOrderLoadedTableId(table.id);
      })
      .catch(() => {
        if (!cancelled) setGuestTable(null);
      })
      .finally(() => {
        if (!cancelled) setGuestChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, user, guestTableId, loading]);

  useEffect(() => {
    if (!selectedTableId || !user || !api) return;
    let cancelled = false;
    const loadSeq = ++orderLoadSeqRef.current;
    const targetTableId = selectedTableId;
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    cancelPendingCustomerLookup();
    fetchTableOrder(targetTableId)
      .then((res) => {
        if (
          cancelled ||
          sendInFlightRef.current ||
          loadSeq !== orderLoadSeqRef.current ||
          selectedTableIdRef.current !== targetTableId
        ) {
          return;
        }
        const order = res.data.orders?.[0] || null;
        setCurrentOrder(order);
        const pendingAttempt =
          sendAttemptRef.current?.snapshot.tableId === targetTableId
            ? sendAttemptRef.current.snapshot
            : null;
        if (pendingAttempt) {
          setCustomerName(pendingAttempt.customerName);
          setCustomerPhone(pendingAttempt.customerPhone);
        } else if (order?.customer) {
          setCustomerName(order.customer.name || '');
          setCustomerPhone(order.customer.phone || '');
        } else {
          setCustomerName('');
          setCustomerPhone('');
        }
        setCustomerMatch(null);
        setCustomerSearched(false);
        orderLoadedTableIdRef.current = targetTableId;
        setOrderLoadedTableId(targetTableId);
      })
      .catch(() => {
        if (
          !cancelled &&
          !sendInFlightRef.current &&
          loadSeq === orderLoadSeqRef.current &&
          selectedTableIdRef.current === targetTableId
        ) {
          setCurrentOrder(null);
          orderLoadedTableIdRef.current = '';
          setOrderLoadedTableId('');
          orderLookupFailedRef.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedTableId, user]);

  useEffect(() => {
    return () => {
      clearTimeout(phoneDebounceRef.current);
      phoneAbortRef.current?.abort();
    };
  }, []);

  function handleOrderNotesChange(value: string) {
    if (sendInFlightRef.current) return;
    setOrderNotes(value.slice(0, 200));
  }

  /** Moves the table's open order to a free table and follows it there. */
  /** Moves the open order to a free table, or merges all its items into another table's order. */
  async function transferOrderTo(mode: TransferMode, target: TransferTable) {
    if (!api || !currentOrder || !selectedTableId) return;
    setTransferring(true);
    try {
      if (mode === 'move') {
        await api.post(`/api/tables/${selectedTableId}/move-order`, {
          target_table_id: target.id,
          order_id: currentOrder.id,
        });
      } else {
        await api.post(`/api/orders/${currentOrder.id}/merge-table`, { target_table_id: target.id });
      }
      toast.success(mode === 'move' ? t('tableMoved', { name: target.name }) : t('tablesMerged', { name: target.name }));
      setTransferMode(null);
      const listWasOpen = orderedItemsOpen;
      await loadAll({ allowWhileSending: true }).catch(() => {});
      selectTable(target.id);
      // Started from the ordered-items list: show it again for the table the items went to.
      if (listWasOpen) setOrderedItemsOpen(true);
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'source_billed') toast.error(t('mergeBlockedBilled'));
      else if (code === 'source_discount') toast.error(t('mergeBlockedDiscount'));
      else if (code === 'target_paying') toast.error(t('mergeBlockedPaying'));
      else if (code === 'target_empty') toast.error(t('tableHasNoOrder', { name: target.name }));
      else toastApiError(error, mode === 'move' ? t('moveTableFailed') : t('mergeTableFailed'), apiErrorT);
    } finally {
      setTransferring(false);
    }
  }

  /** Prints the table's bill and records the request, so the POS times the wait for payment. */
  async function requestBill() {
    if (!api || !currentOrder) return;
    try {
      await api.post(`/api/orders/${currentOrder.id}/bill-request`, {});
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'weight_pending') toast.error(t('billBlockedPricePending'));
      else if (code === 'served_unconfirmed') toast.error(t('billBlockedNotServed'));
      else toastApiError(error, t('billRequestFailed'), apiErrorT);
      return;
    }
    await printOrderSlip(currentOrder.id, {
      ...currentOrder,
      table: activeTable ? { name: activeTable.name ?? String(activeTable.number) } : undefined,
    } as unknown as Record<string, unknown>);
    toast.success(t('billRequested'));
  }

  /** Packs a sent item to go, cancels one still waiting, or confirms a served one reached the table. */
  async function changeSentItem(itemId: number, change: 'takeaway' | 'cancel' | 'confirm-served') {
    if (!api || !currentOrder || sendInFlightRef.current) return;
    const tableId = selectedTableIdRef.current;
    try {
      await api.patch(
        `/api/orders/${currentOrder.id}/items/${itemId}/${change}`,
        change === 'cancel' ? { reason: 'Cancelled from the Server App' } : {},
      );
      toast.success(
        change === 'cancel'
          ? t('itemCancelled')
          : change === 'confirm-served'
            ? t('itemServedConfirmed')
            : t('itemChangedToTakeaway'),
      );
    } catch (error: unknown) {
      toastApiError(error, t('itemChangeFailed'), apiErrorT);
    }
    if (tableId) await loadOrder(tableId).catch(() => {});
  }

  function clearSelectedTable() {
    selectedTableIdRef.current = '';
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    setOrderLoadedTableId('');
    setCurrentOrder(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerMatch(null);
    setCustomerSearched(false);
    setOrderedItemsOpen(false);
    setSelectedTableId('');
  }

  function selectTable(tableId: string) {
    if (sendInFlightRef.current) return;
    if (tableId === selectedTableIdRef.current) {
      if (orderLookupFailedRef.current) {
        loadOrder(tableId).catch(() => toast.error(t('couldNotLoadData')));
      }
      return;
    }
    selectedTableIdRef.current = tableId;
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    setOrderLoadedTableId('');
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    setCurrentOrder(null);
    const pendingAttempt =
      sendAttemptRef.current?.snapshot.tableId === tableId ? sendAttemptRef.current.snapshot : null;
    setCustomerName(pendingAttempt?.customerName ?? '');
    setCustomerPhone(pendingAttempt?.customerPhone ?? '');
    setCustomerMatch(null);
    setCustomerSearched(false);
    setOrderedItemsOpen(false);
    setSelectedTableId(tableId);
  }

  function openAddonModal(
    product: Product,
    quantity: number,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    addonModalSendSeqRef.current = sendSeqRef.current;
    setAddonModalQuantity(quantity);
    setAddonModalVariant(variant);
    setAddonModalProduct(product);
  }

  function openEditDraftModal(line: DraftLine) {
    if (sendInFlightRef.current) return;
    editingDraftSendSeqRef.current = sendSeqRef.current;
    setEditingDraftLine(line);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    setLoginLoading(true);
    try {
      const res = await api.post('/api/auth/login', {
        identifier: email.trim(),
        password,
      });
      localStorage.setItem(TOKEN_KEY, res.data.access_token);
      setUser(res.data.user);
      setShowLogin(false);
    } catch (error: unknown) {
      toastApiError(error, t('signInFailed'), apiErrorT);
    } finally {
      setLoginLoading(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem(TOKEN_KEY);
    let expiresAt = 0;
    try {
      expiresAt = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
    } catch {
      return;
    }
    if (!Number.isFinite(expiresAt)) return;
    const endSession = () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      endSession();
      return;
    }
    const timer = setTimeout(endSession, Math.min(remaining, 2 ** 31 - 1));
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= expiresAt) endSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user]);

  async function logout() {
    try {
      await api?.post('/api/auth/logout');
    } catch {}
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }

  function addDraftLine(
    product: Product,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    setDraft((lines) => {
      const lineId = generateCartItemId(
        product.id,
        variant?.id ?? null,
        addons,
        specialInstructions,
      );
      const existing = lines.find((line) => line.id === lineId);
      if (existing) {
        return lines.map((line) =>
          line.id === lineId ? { ...line, quantity: line.quantity + quantity } : line,
        );
      }
      return [
        ...lines,
        {
          id: lineId,
          product,
          quantity,
          addons,
          special_instructions: specialInstructions,
          variant,
        },
      ];
    });
  }

  function updateDraftLine(
    lineId: string,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    setDraft((lines) => {
      const target = lines.find((line) => line.id === lineId);
      if (!target) return lines;

      const newId = generateCartItemId(
        target.product.id,
        (variant ?? target.variant)?.id ?? null,
        addons,
        specialInstructions,
      );
      if (newId === lineId) {
        return lines.map((line) =>
          line.id === lineId
            ? {
                ...line,
                quantity,
                addons,
                special_instructions: specialInstructions,
                variant: variant ?? target.variant ?? null,
              }
            : line,
        );
      }

      // The edit produced a config that matches another existing line — merge into it.
      const collision = lines.find((line) => line.id === newId && line.id !== lineId);
      if (collision) {
        return lines
          .filter((line) => line.id !== lineId)
          .map((line) =>
            line.id === newId ? { ...line, quantity: line.quantity + quantity } : line,
          );
      }
      return lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              id: newId,
              quantity,
              addons,
              special_instructions: specialInstructions,
              variant: variant ?? target.variant ?? null,
            }
          : line,
      );
    });
  }

  function removeDraftLine(lineId: string) {
    if (sendInFlightRef.current) return;
    setDraft((lines) => lines.filter((line) => line.id !== lineId));
  }

  function changeQty(lineId: string, delta: number) {
    if (sendInFlightRef.current) return;
    setDraft((lines) =>
      lines
        .map((line) => (line.id === lineId ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  async function ensureCustomer(
    submittedName: string,
    submittedPhone: string,
  ): Promise<string | null> {
    if (!api) return null;
    const name = submittedName.trim();
    const rawPhone = submittedPhone.trim();
    if (!name && !rawPhone) return null;
    let normalizedPhone: string | undefined = undefined;
    if (rawPhone) {
      const parsed = regional?.country ? parsePhone(rawPhone, regional.country) : null;
      normalizedPhone = parsed ? parsed.e164 : rawPhone;
      try {
        const lookup = await api.get('/api/crm/lookup', {
          params: { phone: normalizedPhone },
        });
        if (lookup.data.found && lookup.data.customer?.id) return lookup.data.customer.id;
      } catch {}
    }
    const fallbackName = name || t('guestFallbackName', { last4: rawPhone.slice(-4) });
    const res = await api.post('/api/customers', {
      name: fallbackName,
      phone: normalizedPhone || undefined,
    });
    return res.data.customer?.id || null;
  }

  // Falls back to this device's browser print dialog when no hardware printer is configured (400).
  async function printKotForOrder(orderId: number, orderForPrint: Record<string, unknown>) {
    if (!api) return;
    try {
      await api.post('/api/printers/print-kot', {
        orderId,
        items: orderForPrint.items,
      });
      return;
    } catch (printError: unknown) {
      const status = axios.isAxiosError(printError) ? printError.response?.status : undefined;
      if (status !== 400) {
        toastApiError(printError, t('kotPrintFailed'), apiErrorT);
        return;
      }
    }
    try {
      const { generateKotHtml, resolveKotTicketLanguage } =
        await import('@/lib/printer/kot-web-print');
      const html = generateKotHtml(orderForPrint as unknown as FullOrder, {
        paperWidth: 80,
        language: resolveKotTicketLanguage(),
        stationName: t('kitchen'),
      });
      await printerService.printViaBrowser(html, 80);
    } catch (fallbackError: unknown) {
      toastApiError(fallbackError, t('kotPrintFailed'), apiErrorT);
    }
  }

  // Same browser-print fallback as KOT above on 400; stays quiet on 403 (owner hasn't enabled server bill printing).
  async function printOrderSlip(orderId: number, orderForPrint: Record<string, unknown>) {
    if (!api) return;
    try {
      await api.post('/api/printers/print-bill', { orderId });
      return;
    } catch (printError: unknown) {
      const status = axios.isAxiosError(printError) ? printError.response?.status : undefined;
      if (status === 403) return;
      if (status !== 400) {
        toastApiError(printError, t('billPrintFailed'), apiErrorT);
        return;
      }
    }
    try {
      const { generateOrderSlipHtml } = await import('@/lib/printer/order-slip-web-print');
      const html = generateOrderSlipHtml(
        orderForPrint as unknown as FullOrder,
        {
          title: t('orderSlipTitle'),
          subtotal: t('orderSlipSubtotal'),
          discount: t('orderSlipDiscount'),
          serviceCharge: t('orderSlipServiceCharge'),
          deliveryCharge: t('orderSlipDeliveryCharge'),
          packagingCharge: t('orderSlipPackagingCharge'),
          tax: t('orderSlipTax'),
          total: t('orderSlipTotal'),
        },
        {
          paperWidth: 80,
          country: regional?.country,
          currency: regional?.currency,
          locale: getLanguageLocale(language),
          direction: getLanguageDirection(language),
        },
      );
      await printerService.printViaBrowser(html, 80);
    } catch (fallbackError: unknown) {
      toastApiError(fallbackError, t('billPrintFailed'), apiErrorT);
    }
  }

  async function sendGuestDraft() {
    if (
      !api ||
      !guestTable ||
      draft.length === 0 ||
      sendInFlightRef.current
    ) {
      return;
    }
    const lines = draft.map((line) => ({ ...line, addons: line.addons.map((addon) => ({ ...addon })) }));
    const items = lines.map((line) => cartItemToOrderItem(line));
    const notes = orderNotes.trim();
    const signature = JSON.stringify([guestTable.id, items, notes]);
    if (guestAttemptRef.current?.signature !== signature) {
      guestAttemptRef.current = { signature, key: createPaymentIdempotencyKey() };
    }
    const { key } = guestAttemptRef.current;
    sendInFlightRef.current = true;
    setSending(true);
    try {
      await api.post('/api/guest/order', {
        table_id: guestTable.id,
        items,
        special_instructions: notes || undefined,
        idempotency_key: key,
      });
      if (guestAttemptRef.current?.signature === signature) guestAttemptRef.current = null;
      const submittedQtyById = new Map(lines.map((line) => [line.id, line.quantity]));
      setDraft((currentLines) =>
        currentLines.flatMap((line) => {
          const ackedQty = submittedQtyById.get(line.id);
          if (ackedQty === undefined) return [line];
          const remainingQuantity = line.quantity - ackedQty;
          return remainingQuantity > 0 ? [{ ...line, quantity: remainingQuantity }] : [];
        }),
      );
      setOrderNotes((currentNotes) => (currentNotes === orderNotes ? '' : currentNotes));
      setMobileCartOpen(false);
      toast.success(t('orderSent'));
    } catch (error: unknown) {
      toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  async function sendDraft() {
    if (!user) {
      await sendGuestDraft();
      return;
    }
    if (
      !api ||
      !selectedTableId ||
      orderLoadedTableIdRef.current !== selectedTableId ||
      draft.length === 0 ||
      sendInFlightRef.current
    ) {
      return;
    }
    const snapshotTable = tables.find((table) => table.id === selectedTableId) || null;
    const candidateSnapshot: SendSnapshot = {
      tableId: selectedTableId,
      tableName: snapshotTable ? snapshotTable.name || snapshotTable.number : undefined,
      orderId: currentOrder?.id ?? null,
      orderCustomer: currentOrder?.customer ?? null,
      existingItemIds: new Set((currentOrder?.items || []).map((item) => item.id)),
      draftLines: draft.map((line) => ({
        ...line,
        addons: line.addons.map((addon) => ({ ...addon })),
      })),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      orderNotes,
    };
    // Nonce first via the LAN-safe helper: anything thrown after the
    // sending flag is set sticks the UI on Sending... forever.
    const signature = sendAttemptSignature(
      candidateSnapshot.tableId,
      candidateSnapshot.draftLines,
      candidateSnapshot.customerName,
      candidateSnapshot.customerPhone,
      candidateSnapshot.orderNotes,
    );
    if (sendAttemptRef.current?.signature !== signature) {
      sendAttemptRef.current = {
        signature,
        nonce: createPaymentIdempotencyKey(),
        snapshot: candidateSnapshot,
      };
    }
    const { nonce, snapshot } = sendAttemptRef.current;
    const idempotencyKey = `server-app-${snapshot.tableId}-${nonce}`;
    sendSeqRef.current += 1;
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    sendInFlightRef.current = true;
    setSending(true);
    try {
      const customerId = await ensureCustomer(snapshot.customerName, snapshot.customerPhone);
      const items = snapshot.draftLines.map((line) => cartItemToOrderItem(line));
      const specialInstructions = snapshot.orderNotes.trim() || undefined;
      let orderId: number;
      let rawOrder: Record<string, unknown>;
      let newItems: OrderItem[];
      if (snapshot.orderId) {
        const { data } = await api.post(
          `/api/orders/${snapshot.orderId}/items`,
          { items, special_instructions: specialInstructions },
          {
            headers: { 'Idempotency-Key': idempotencyKey },
          },
        );
        orderId = data.order.id;
        rawOrder = data.order;
        // Print only what this call added — omitting items reprints every pending item on the order.
        newItems = (data.order.items || []).filter(
          (item: OrderItem) => !snapshot.existingItemIds.has(item.id),
        );
      } else {
        const { data } = await api.post(
          '/api/orders',
          {
            table_id: snapshot.tableId,
            customer_id: customerId,
            type: 'dine_in',
            special_instructions: specialInstructions,
            items,
          },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        );
        orderId = data.order.id;
        rawOrder = data.order;
        newItems = data.order.items || [];
      }
      if (sendAttemptRef.current?.signature === signature) {
        sendAttemptRef.current = null;
      }
      const submittedQtyById = new Map(snapshot.draftLines.map((line) => [line.id, line.quantity]));
      setDraft((currentLines) =>
        currentLines.flatMap((line) => {
          const ackedQty = submittedQtyById.get(line.id);
          if (ackedQty === undefined) return [line];
          const remainingQuantity = line.quantity - ackedQty;
          return remainingQuantity > 0 ? [{ ...line, quantity: remainingQuantity }] : [];
        }),
      );
      setOrderNotes((currentNotes) => (currentNotes === snapshot.orderNotes ? '' : currentNotes));
      if (selectedTableIdRef.current === snapshot.tableId) {
        setCurrentOrder(rawOrder as unknown as Order);
        orderLoadedTableIdRef.current = snapshot.tableId;
        setOrderLoadedTableId(snapshot.tableId);
      }
      setMobileCartOpen(false);
      await Promise.all([
        loadAll({ allowWhileSending: true }),
        loadOrder(snapshot.tableId, { allowWhileSending: true }),
      ]).catch(() => {});
      toast.success(t('orderSent'));
      if (user && !guestTable) clearSelectedTable();
      // rawOrder only has table_id/customer_id; the KOT/slip renderers need the nested table/customer for display.
      const enrichedOrder = {
        ...rawOrder,
        table: snapshot.tableName ? { name: snapshot.tableName } : undefined,
        customer:
          snapshot.orderCustomer ||
          (snapshot.customerName ? { name: snapshot.customerName } : undefined),
      };
      // Backgrounded so an unreachable printer can't block Send; sequenced (not concurrent)
      // since KOT and bill can share a default printer and race its socket connection.
      void (async () => {
        await printKotForOrder(orderId, { ...enrichedOrder, items: newItems });
        await printOrderSlip(orderId, enrichedOrder);
      })();
    } catch (error: unknown) {
      toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  const activeTable = tables.find((table) => table.id === selectedTableId) || null;
  const draftTotal = draft.reduce((sum, line) => {
    const addonTotal = line.addons.reduce(
      (addonSum, addon) => addonSum + Number(addon.price || 0) * (addon.quantity || 1),
      0,
    );
    return (
      sum + ((Number(line.variant?.price ?? line.product.price) || 0) + addonTotal) * line.quantity
    );
  }, 0);
  const draftQuantities = useMemo(() => {
    const quantities = new Map<string, number>();
    for (const line of draft) {
      quantities.set(line.product.id, (quantities.get(line.product.id) || 0) + line.quantity);
    }
    return quantities;
  }, [draft]);
  const draftItemCount = draft.reduce((sum, line) => sum + line.quantity, 0);

  const guestMode = !user && !!guestTable && !showLogin;
  const waitingForGuest =
    !user && (guestTableId === undefined || (!!guestTableId && !guestChecked));

  if (loading || waitingForGuest) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <Smartphone size={44} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('disabledTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('disabledHint')}</p>
      </div>
    );
  }

  if (!user && !guestMode) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm"
        >
          {regional?.server_time && regional.timezone && (
            <div className="-mx-6 -mt-6 mb-5 rounded-t-xl border-b border-border bg-muted/40 px-6 py-4">
              <StoreClock
                key={regional.server_time}
                serverTime={regional.server_time}
                timezone={regional.timezone}
                country={regional.country}
              />
            </div>
          )}
          <div className="mb-6 text-center">
            <UserRound size={42} className="mx-auto mb-3 text-red-600" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('loginSubtitle')}</p>
          </div>
          <div className="space-y-3">
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="text"
              autoComplete="username"
              placeholder={t('staffNamePlaceholder')}
              required
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder={t('staffCodePlaceholder')}
              required
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <button
              disabled={loginLoading}
              className="h-11 w-full rounded-lg bg-brand font-semibold text-white disabled:opacity-60"
            >
              {loginLoading ? tAuth('signingIn') : tAuth('signIn')}
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">{t('loginHint')}</p>
          {guestTable && (
            <button
              type="button"
              onClick={() => setShowLogin(false)}
              className="mt-3 w-full text-center text-sm font-medium text-muted-foreground underline"
            >
              {t('continueAsGuest')}
            </button>
          )}
        </form>
      </div>
    );
  }

  const ticketPanelBody = (
    <>
      <div className="relative flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('currentTicket')}</h2>
        {user && currentOrder && selectedTableId && (
          <>
            <button
              type="button"
              data-testid="server-app-ticket-menu"
              aria-label={t('ticketActions')}
              aria-haspopup="menu"
              aria-expanded={ticketMenuOpen}
              disabled={sending}
              onClick={() => setTicketMenuOpen((open) => !open)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground disabled:opacity-50"
            >
              <MoreVertical size={18} />
            </button>
            {ticketMenuOpen && (
              <div
                role="menu"
                className="absolute end-0 top-full z-20 min-w-44 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
              >
                {(['move', 'merge'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setTicketMenuOpen(false);
                      setMobileCartOpen(false);
                      setTransferMode(mode);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm hover:bg-muted"
                  >
                    {mode === 'move' ? <ArrowLeftRight size={16} /> : <Merge size={16} />}
                    {mode === 'move' ? t('moveTable') : t('mergeTable')}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {isWide && user && currentOrder && selectedTableId && (
        <div className="mt-2">
          <TableKitchenSummary
            items={(currentOrder.items ?? []) as OrderedItem[]}
            onOpenDetails={() => setOrderedItemsOpen(true)}
          />
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          {t('newItems')}
        </p>
        {draft.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('emptyDraft')}</p>
        ) : (
          <div className="space-y-3">
            {draft.map((line) => (
              <div key={line.id} className="rounded-lg border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {line.variant
                        ? `${line.product.name} (${line.variant.name})`
                        : line.product.name}
                    </span>
                    {line.addons.length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {line.addons.map((addon) => (
                          <p key={addon.id} className="truncate text-xs text-muted-foreground">
                            + {addon.name}
                            {(addon.quantity || 1) > 1 ? ` x${addon.quantity}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                    {line.special_instructions && (
                      <p className="mt-0.5 truncate text-xs italic text-muted-foreground">
                        {line.special_instructions}
                      </p>
                    )}
                  </div>
                  <button
                    disabled={sending}
                    onClick={() => removeDraftLine(line.id)}
                    aria-label={tCommon('removeItem')}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-red-500 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      disabled={sending}
                      onClick={() => changeQty(line.id, -1)}
                      className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-6 text-center text-sm font-semibold">
                      <Ltr>{line.quantity}</Ltr>
                    </span>
                    <button
                      disabled={sending}
                      onClick={() => changeQty(line.id, 1)}
                      className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    disabled={sending}
                    onClick={() => openEditDraftModal(line)}
                    className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                  >
                    <SquarePen size={12} />
                    {tCommon('edit')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {draft.length > 0 && (
        <div className="mt-3">
          <textarea
            value={orderNotes}
            disabled={sending}
            onChange={(event) => handleOrderNotesChange(event.target.value)}
            placeholder={tPos('orderNotesPlaceholder')}
            rows={2}
            maxLength={200}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none disabled:opacity-50"
          />
          <p className="mt-0.5 text-end text-xs text-muted-foreground">
            <Ltr>{orderNotes.length}/200</Ltr>
          </p>
        </div>
      )}

      {currentOrder?.items && currentOrder.items.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p
            data-testid="server-app-sent-heading"
            className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"
          >
            <span>{t('sentToKitchen')}</span>
            <Ltr as="span" className="rounded bg-muted px-1.5 py-0.5 font-mono normal-case text-foreground">
              #{currentOrder.order_number}
            </Ltr>
          </p>
          <OrderedItemList
            itemTestId="server-app-ticket-item"
            items={currentOrder.items as OrderedItem[]}
            timezone={regional?.timezone}
            onTakeaway={(item) => changeSentItem(item.id, 'takeaway')}
            onCancel={(item) => changeSentItem(item.id, 'cancel')}
            onConfirmServed={(item) => changeSentItem(item.id, 'confirm-served')}
          />
        </div>
      )}

      {/* The total and send button stay in view however long the sent list grows. */}
      <div className="sticky bottom-0 z-10 -mx-3 mt-4 bg-card px-3 pb-3">
      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm text-muted-foreground">{t('draftTotal')}</span>
        <span className="text-lg font-bold">
          <Ltr>{money(draftTotal, regional)}</Ltr>
        </span>
      </div>
      {!selectedTableId && user ? (
        <button
          type="button"
          data-testid="server-app-choose-table"
          onClick={() => {
            setMobileCartOpen(false);
            setTablePickerOpen(true);
          }}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-amber-400 bg-amber-50 font-semibold text-amber-700"
        >
          <UtensilsCrossed size={17} />
          {t('chooseTableFirst')}
        </button>
      ) : (
        <button
          onClick={sendDraft}
          disabled={
            !selectedTableId ||
            orderLoadedTableId !== selectedTableId ||
            draft.length === 0 ||
            sending
          }
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50"
        >
          <Send size={17} />
          {sending ? t('sending') : currentOrder ? t('addToOrder') : t('sendToKitchen')}
        </button>
      )}
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
            <ChefHat size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{t('title')}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {activeTable
                ? t('tableLabel', {
                    name: activeTable.name ?? String(activeTable.number),
                  })
                : t('selectTable')}
            </p>
          </div>
          {user ? (
            <>
              <span
                data-testid="server-app-staff-name"
                className="hidden max-w-[96px] truncate text-sm font-medium min-[400px]:block"
              >
                {user.name}
              </span>
              <button
                type="button"
                disabled={sending}
                onClick={() => setTablePickerOpen((open) => !open)}
                aria-expanded={tablePickerOpen}
                data-testid="server-app-table-button"
                className="flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-400 bg-amber-50 px-3 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
              >
                <UtensilsCrossed size={14} />
                {t('selectTable')}
              </button>
            </>
          ) : (
            <span data-testid="server-app-guest-name" className="text-sm font-medium text-muted-foreground">
              {t('guestLabel')}
            </span>
          )}
          {user ? (
            <button
              onClick={logout}
              aria-label={tNav('logout')}
              title={tNav('logout')}
              data-testid="server-app-session-button"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-green-600 p-2 text-green-600"
            >
              <UserRound size={17} />
            </button>
          ) : (
            <button
              onClick={() => setShowLogin(true)}
              aria-label={tAuth('signIn')}
              title={tAuth('signIn')}
              data-testid="server-app-login-button"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-orange-500 p-2 text-white hover:bg-orange-600"
            >
              <UserRound size={17} />
            </button>
          )}
        </div>
      </header>

      {tablesLoaded && tables.length === 0 ? (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
          <LayoutGrid size={44} className="text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('noTablesTitle')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('noTablesHint')}</p>
        </div>
      ) : (
        <main
          className={`mx-auto grid max-w-6xl min-w-0 gap-3 p-3 ${user && tablePickerOpen ? 'lg:grid-cols-[220px_1fr_340px]' : 'lg:grid-cols-[1fr_340px]'}`}
        >
          {user && tablePickerOpen && (
          <section className="min-w-0 rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              {t('tables')}
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1">
              {ownedOrAllTables(tables, user?.id).map((table) => {
                const selected = table.id === selectedTableId;
                const order = table.activeOrder || table.current_order;
                return (
                  <button
                    key={table.id}
                    disabled={sending}
                    // The picker stays open so the table's actions show before adding food.
                    onClick={() => selectTable(table.id)}
                    className={`min-h-14 rounded-lg border px-2 py-2 text-start disabled:opacity-50 ${selected ? 'border-brand bg-brand/10' : 'border-border bg-card'}`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {table.name || table.number}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {order ? t('openOrder') : tTables('statusAvailable')}
                      {order?.kitchen_counts && (
                        <Ltr
                          as="span"
                          data-testid="table-kitchen-counts"
                          title={t('kitchenCountsTitle', order.kitchen_counts)}
                          className="ms-1 tabular-nums text-gray-400"
                        >
                          {order.kitchen_counts.waiting}-{order.kitchen_counts.ready}-{order.kitchen_counts.served}
                        </Ltr>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          )}

          <section className="flex h-[calc(100dvh-5rem)] min-h-96 min-w-0 flex-col rounded-lg border border-border bg-card p-3">
            {user && tablePickerOpen && activeTable && !isWide && (
              <div data-testid="server-app-table-actions" className="mb-3 space-y-2">
                <button
                  type="button"
                  data-testid="server-app-add-food"
                  onClick={() => setTablePickerOpen(false)}
                  className="flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-brand text-sm font-semibold text-brand"
                >
                  <Plus size={17} />
                  {t('addFoodItems')}
                </button>
                <TableKitchenSummary
                  items={(currentOrder?.items ?? []) as OrderedItem[]}
                  onOpenDetails={() => setOrderedItemsOpen(true)}
                />
              </div>
            )}
            <ProductGrid
              categories={categories}
              products={products}
              selectedCategory={selectedCategoryId}
              setSelectedCategory={setSelectedCategoryId}
              search={query}
              setSearch={setQuery}
              currency={regional?.currency || ''}
              disabled={sending}
              onProductClick={(product, quantity) => {
                if (sendInFlightRef.current) return;
                if (productNeedsCustomizer(product)) {
                  openAddonModal(product, quantity, null);
                } else addDraftLine(product, quantity, [], '');
              }}
              onScannedVariant={(product, variant, quantity) => {
                if (sendInFlightRef.current) return;
                if (scannedVariantNeedsCustomizer(product, variant)) {
                  openAddonModal(product, quantity, variant);
                } else addDraftLine(product, quantity, [], '', variant);
              }}
              onScaledProduct={(product, quantity) => {
                if (sendInFlightRef.current) return;
                addDraftLine(product, quantity, [], '');
              }}
              cartQuantities={draftQuantities}
              formatPrice={(amount) => money(amount, regional)}
              showImages={true}
              gridClassName="grid-cols-2 sm:grid-cols-3 xl:grid-cols-4"
              searchPlaceholder={t('searchMenu')}
              scrollSpy
            />
          </section>

          <section
            data-testid="server-app-ticket-panel"
            className="hidden min-w-0 rounded-lg border border-border bg-card p-3 pb-0 md:block md:sticky md:top-16 md:max-h-[calc(100dvh-5rem)] md:self-start md:overflow-y-auto"
          >
            {ticketPanelBody}
          </section>
        </main>
      )}

      {transferMode && activeTable && (
        <TableTransferDialog
          mode={transferMode}
          fromName={activeTable.name ?? String(activeTable.number)}
          fromId={activeTable.id}
          busy={transferring}
          tables={tables.map((table) => ({
            id: table.id,
            name: table.name ?? String(table.number),
            occupied: Boolean(table.activeOrder || table.current_order),
            reserved: table.status === 'reserved',
          }))}
          onConfirm={(target) => void transferOrderTo(transferMode, target)}
          onClose={() => setTransferMode(null)}
        />
      )}

      {orderedItemsOpen && activeTable && (
        <OrderedItemsScreen
          tableName={activeTable.name ?? String(activeTable.number)}
          orderNumber={currentOrder?.order_number}
          items={(currentOrder?.items ?? []) as OrderedItem[]}
          timezone={regional?.timezone}
          onBack={() => setOrderedItemsOpen(false)}
          onAddItems={() => {
            setOrderedItemsOpen(false);
            setTablePickerOpen(false);
          }}
          onTakeaway={(item) => changeSentItem(item.id, 'takeaway')}
          onCancel={(item) => changeSentItem(item.id, 'cancel')}
          onConfirmServed={(item) => changeSentItem(item.id, 'confirm-served')}
          onPrintBill={requestBill}
          onMoveTable={() => setTransferMode('move')}
          onMergeTable={() => setTransferMode('merge')}
        />
      )}

      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button
            data-testid="server-app-cart-button"
            className={`${orderedItemsOpen ? 'hidden' : 'flex'} fixed bottom-5 end-5 z-40 h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-hover active:bg-brand-hover md:hidden`}
            aria-label={t('currentTicket')}
          >
            <ShoppingCart size={22} />
            {draftItemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                <Ltr>{draftItemCount}</Ltr>
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh] text-foreground">
          <div className="max-h-[80vh] overflow-y-auto px-3 pb-3">{ticketPanelBody}</div>
        </DrawerContent>
      </Drawer>

      {addonModalProduct && (
        <AddonModal
          product={addonModalProduct}
          currency={regional?.currency || ''}
          country={regional?.country}
          initialQuantity={addonModalQuantity}
          initialVariant={addonModalVariant}
          onAdd={(addedProduct, quantity, addons, instructions, variant) => {
            if (sendInFlightRef.current || addonModalSendSeqRef.current !== sendSeqRef.current) {
              return;
            }
            addDraftLine(addedProduct, quantity, addons, instructions, variant);
          }}
          onClose={() => {
            setAddonModalProduct(null);
            setAddonModalQuantity(1);
            setAddonModalVariant(null);
          }}
        />
      )}

      {editingDraftLine && (
        <AddonModal
          product={editingDraftLine.product}
          currency={regional?.currency || ''}
          country={regional?.country}
          mode="edit"
          initialQuantity={editingDraftLine.quantity}
          initialAddons={editingDraftLine.addons}
          initialInstructions={editingDraftLine.special_instructions}
          initialVariant={editingDraftLine.variant}
          onAdd={(_editedProduct, quantity, addons, instructions, variant) => {
            if (sendInFlightRef.current || editingDraftSendSeqRef.current !== sendSeqRef.current) {
              return;
            }
            updateDraftLine(editingDraftLine.id, quantity, addons, instructions, variant);
          }}
          onClose={() => setEditingDraftLine(null)}
        />
      )}
    </div>
  );
}
