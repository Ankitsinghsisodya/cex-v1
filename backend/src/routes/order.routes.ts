import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../../util"
import { Side, Status } from "../../generated/enums"
import { ORDERBOOKS, updateORDERBOOKState } from "../services/orderbook.service"

const router = Router();

/*
    body = {
        type:           "market" | "limit",
        price:          number | null,
        qty:            number,
        market_id:      string,
        side:           "buy" | "sell"
    }

    @returns {
        orderId: string,
        filledQty: number,
        averagePrice
    }
*/

// 500001
router.post("/order", async (req: Request, res: Response) => {
    try {
        const {
            type, price, qty, market_id, side
        } = req.body;
        const userId = req.userId!;
        // save an order
        if (!side || (side !== "ASK" && side !== "BID")) {
            return res.status(400).json({
                success: false,
                message: "the side are not valid"
            })
        }
        if (type !== 'MARKET' && type !== 'LIMIT') {
            return res.status(400).json({
                success: false,
                message: "the type is not valid"
            })
        }
        if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
            return res.status(400).json({
                success: false,
                message: "qty must be a positive number"
            })
        }
        const stock = await prisma.stocks.findFirst({
            where: {
                symbol: market_id
            }
        })

        if (!stock) {
            return res.status(400).json({
                success: false,
                message: "Invalid stock"
            })
        }

        const order = await prisma.order.create({
            data: {
                userId,
                side,
                type,
                stockId: stock.id,
                price,
                qty,
                filledQty: 0,
                status: Status.EMPTY
            }
        })
        // let sideEnum = (side == "ASK")? "ASK":"BID";
        const sideEnum: "ASK" | "BID" = side === "ASK" ? "ASK" : "BID";
        const book = ORDERBOOKS[stock.symbol];
        if (!book) {
            return res.status(400).json({
                success: false,
                message: "Invalid stock"
            })
        }

        if (!book[sideEnum][price]) {
            book[sideEnum][price] = { totalQty: 0, Order: [] }
        }

        book[sideEnum][price].totalQty += qty;
        book[sideEnum][price].Order.push({
            userId: order.userId,
            filledQty: order.filledQty,
            qty: qty,
            orderId: order.id
        });

        let filledQty = updateORDERBOOKState(type, price, qty, side, stock, userId);
        let status: Status = Status.EMPTY;
        if (filledQty === qty) status = Status.FILLED;
        else if (filledQty) status = Status.PARTIAL;
        prisma.order.create({
            data: {
                userId,
                side,
                type,
                stockId: stock.id,
                price,
                qty,
                filledQty,
                status
            }
        })
        // ORDERBOOKS[stock.symbol][side][price]?.totalQty += qty;
        // filledQty


    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})
/*
    returns the status of an order (partially filled, success, cancellled)
    ALSO RETURNS THE INDIVIDUAL FILLS OF THIS ORDER 
*/
router.get("/order/:orderId", async (req: Request, res: Response) => {
    try {
        const order = await prisma.order.findFirst({
            where: {
                id: Number(req.params.orderId)
            }
        })
        if (!order) {
            return res.status(400).json({
                success: false,
                message: "wrong orderId"
            })
        }
        const Fills = await prisma.fills.findMany({
            where: {
                OR: [
                    { buyOrderId: Number(req.params.orderId) },
                    { sellOrderId: Number(req.params.orderId) }

                ]
            }
        })
        return res.status(201).json({
            success: true,
            status: order.status,
            Fills
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})


router.delete("/order/:orderId", async (req: Request, res: Response) => {
    try {
        const orderId = Number(req.params.orderId);
        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "missing orderId param"
            })
        }

        const isOrderIdValid  = await prisma.order.findFirst({
            where:{
                id: orderId
            }
        });
        if(!orderId){
            return res.status(400).json({
                success:false,
                message: "The order id doesn't exits"
            })
        }
        const result = await prisma.order.delete({
            where: {
                id: orderId
            }
        })
        return res.status(201).json({
            success: true,
            deletedOrder: result
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

/*
    Returns every order placed by the authenticated user.
*/
router.get("/orders", async (req: Request, res: Response) => {
    try {
        const userId = req.userId!;
        const orders = await prisma.order.findMany({
            where: { userId }
        })
        return res.status(200).json({
            success: true,
            orders
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

/*
    Returns every fill where the authenticated user was the buyer or the
    seller.
*/
router.get("/fills", async (req: Request, res: Response) => {
    try {
        const userId = req.userId!;
        const fills = await prisma.fills.findMany({
            where: {
                OR: [
                    { buyOrder: { userId } },
                    { sellOrder: { userId } }
                ]
            }
        })
        return res.status(200).json({
            success: true,
            fills
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

export default router;
