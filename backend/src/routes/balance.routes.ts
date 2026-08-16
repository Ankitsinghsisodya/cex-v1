import { Router } from "express";
import type { Request, Response } from "express";
import { ensureUserBalance } from "../services/orderbook.service"

const router = Router();

/*
    Returns the authenticated user's USD balance.
*/
router.get("/balance/usd", (req: Request, res: Response) => {
    const userId = req.userId!;
    const balance = ensureUserBalance(userId);
    return res.status(200).json({
        success: true,
        usd: balance.usd
    })
})

/*  
    Returns the balance of all stocks
*/
router.get("/balance", (req: Request, res: Response) => {
    const userId = req.userId!;
    const balance = ensureUserBalance(userId);
    return res.status(200).json({
        success: true,
        balances: balance.stocks
    })
})

export default router;
