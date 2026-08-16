import { Router } from "express";
import type { Request, Response } from "express";
import { ORDERBOOKS } from "../services/orderbook.service"

const router = Router();

router.get("/depth/:symbol", async (req: Request, res: Response) => {
    try {
        const stockSymbol = req.params.symbol;
        if (!stockSymbol) {
            return res.status(401).json({
                success: false,
                message: "symbol are not present"
            })
        }
        if(typeof stockSymbol !== "string"){
            return res.status(401).json({
                success: false,
                message: "symbol is not in valid format"
            })
        }
        if (stockSymbol in Object.keys(ORDERBOOKS))
        {
            return res.status(201).json({
                success: true,
                orderBook: ORDERBOOKS[stockSymbol]
            })
        }
    } catch (error) {
    return res.status(500).json({
        success: false,
        message: "Server side error"
    })
}
});

export default router;
