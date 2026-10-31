import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import { notifyKdsUpdate } from '../services/kds';
import { addKdsAlert, KDS_ALERT_MESSAGE_MAX } from '../services/kds-alerts';

const router = Router();

// POST /api/kds-alerts — service staff call the kitchen about an emergency; every display shows it.
router.post('/', requirePermission('server-app.use'), (req: Request, res: Response) => {
  try {
    const { message, table } = (req.body ?? {}) as { message?: unknown; table?: unknown };
    if (message !== undefined && typeof message !== 'string') {
      return res.status(400).json({ error: 'message must be text' });
    }
    if (typeof message === 'string' && message.trim().length > KDS_ALERT_MESSAGE_MAX) {
      return res.status(400).json({ error: `message must be at most ${KDS_ALERT_MESSAGE_MAX} characters` });
    }
    if (table !== undefined && table !== null && typeof table !== 'string') {
      return res.status(400).json({ error: 'table must be text' });
    }
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    const actor = getDatabase().prepare('SELECT name FROM users WHERE id = ?').get(userId) as
      | { name: string }
      | undefined;
    const alert = addKdsAlert({ message, table: table ?? null, sentBy: actor?.name ?? null });
    console.log(`[KDS] Emergency alert sent by user ${userId}`);
    notifyKdsUpdate();
    res.status(201).json({ alert });
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as kdsAlertRoutes };
