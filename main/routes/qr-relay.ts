import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../services/authorization';
import {
  QrRelayError,
  cancelQrRelayPairing,
  checkQrRelayPairing,
  getQrRelayStatus,
  startQrRelayPairing,
  unpairQrRelay,
} from '../services/qr-relay';

const router = Router();

function fail(res: Response, error: unknown) {
  if (error instanceof QrRelayError) {
    const status = error.code === 'server_url_invalid' || error.code === 'not_pairing' ? 400 : 502;
    return res.status(status).json({ code: error.code, error: error.code, ...getQrRelayStatus() });
  }
  console.error('[API] QR relay error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

router.get('/', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json(getQrRelayStatus());
});

router.post('/pair', requirePermission('settings.manage'), async (req: Request, res: Response) => {
  try {
    await startQrRelayPairing(req.body?.server_url);
    res.json(getQrRelayStatus());
  } catch (error) {
    fail(res, error);
  }
});

router.post('/pair/check', requirePermission('settings.manage'), async (_req: Request, res: Response) => {
  try {
    await checkQrRelayPairing();
    res.json(getQrRelayStatus());
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/pair', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  cancelQrRelayPairing();
  res.json(getQrRelayStatus());
});

router.delete('/', requirePermission('settings.manage'), async (_req: Request, res: Response) => {
  try {
    await unpairQrRelay();
    res.json(getQrRelayStatus());
  } catch (error) {
    fail(res, error);
  }
});

export { router as qrRelayRoutes };
