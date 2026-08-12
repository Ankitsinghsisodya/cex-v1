import express from "express";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./util"
import jwt from "jsonwebtoken";
import { Side, Status } from "./generated/enums";
import type { stocks } from "./generated/client"



const app = express();

app.use(express.json());

const BALANCES: BalanceEntry = {

}

type BalanceEntry = { [userId: number]: currencyDetail }

type currencyDetail = {
    [k in currencyDetailNames]?: number
}
type currencyDetailNames = "USD" | "BTC" | "SOL";
type OrderEntry = {
    userId: number,
    qty: number,
    filledQty: number,
    orderId: number,
}

type PriceLevel = {
    totalQty: number,
    Order: OrderEntry[]
}

type stockOrderBook = {
    ASK: { [price: number]: PriceLevel },
    BID: { [price: number]: PriceLevel }
}

type OrderBook = {
    [symbol: string]: stockOrderBook
}
const ORDERBOOKS: OrderBook = {
    SOL: {
        ASK: {},
        BID: {}
    },
    BTC: {
        ASK: {},
        BID: {}
    }
}



/*
    username
    password
*/
app.post("/signup", async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({
                success: false,
                message: "Input fields are missing"
            })
        if (typeof username !== "string") {
            return res.status(400).json({
                success: false,
                message: "userName should be string"
            })
        }

        const existingUser = await prisma.user.findFirst(
            {
                where: {
                    username: username
                }
            });


        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "User is already existing"
            })
        }

        const hashedPassword = await Bun.password.hash(password);

        const newUser = await prisma.user.create({
            data: {
                username,
                password: hashedPassword
            }
        })

        BALANCES[newUser.id] = {
            "USD": 0
        }

        return res.status(201).json({
            success: true,
            message: "User is created successfully",
            user: {
                id: newUser.id,
                username: newUser.username
            }
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

app.post("/signin", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Required fields are missing"
            })
        }

        const existingUser = await prisma.user.findFirst({
            where: {
                username
            }
        });

        if (!existingUser) {
            return res.status(401).json({
                success: false,
                message: "User is not present"
            })
        }

        const isPasswordCorrect = await Bun.password.verify(password, existingUser.password);
        if (!isPasswordCorrect) {
            return res.status(401).json({
                success: false,
                message: "The password is incorrect"
            })
        }

        if (!process.env.SECRET) {
            throw new Error("jwt secret is missing");
        }

        const token = jwt.sign({ "userId": existingUser.id }, process.env.SECRET, {
            expiresIn: "1h"
        });

        // success
        return res.status(201).json({
            success: true,
            token

        })
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

app.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.headers["authorization"];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "The user is not authenticated"
            })
        }
        if (!process.env.SECRET) {
            throw new Error("jwt secret in not availabe")
        }
        const decode = jwt.verify(token, process.env.SECRET);

        if (typeof decode === "string") {
            return res.status(401).json({
                success: false,
                message: "Invalid token"
            })
        }

        req.userId = decode.userId;

        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})
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

// 50.01

function clearAllTheOrderForMarketOrder(bookWithBid: { [price: number]: PriceLevel }, price: number, userId: number, stock: stocks, qty: number) {
    if (bookWithBid[price]) {
        bookWithBid[price].totalQty = 0;
        bookWithBid[price].Order.forEach((order) => {
            prisma.fills.create({
                data: {
                    stockId: stock.id,
                    price,
                    qty,
                    buyOrderId: userId,
                    sellOrderId: order.userId
                }
            })
        });
        bookWithBid[price].Order = []
    }
}

function ReducetheQty(bookWithBid: { [price: number]: PriceLevel }, price: number, userId: number, stock: stocks, qty: number, req: number) {
    if (bookWithBid[price]) {
        let newOrderList: OrderEntry[] = [];
        bookWithBid[price].Order.forEach((order) => {
            if (req >= order.qty) {
                req -= order.qty;
                prisma.fills.create({
                    data: {
                        stockId: stock.id,
                        price,
                        qty,
                        buyOrderId: userId,
                        sellOrderId: order.userId
                    }
                })
            }
            else if (req) {
                req = 0;
                prisma.fills.create({
                    data: {
                        stockId: stock.id,
                        price,
                        qty: req,
                        buyOrderId: userId,
                        sellOrderId: order.userId
                    }
                })
                newOrderList.push({
                    ...order, qty: order.qty - req
                })
            }
            else if (req == 0) {
                newOrderList.push(order);
            }
        })

        bookWithBid[price].Order = newOrderList;
    }
}

function askLimitOrder(bookWithBid: { [price: number]: PriceLevel }, priceAsked: number, qty: number, stock: stocks, userId: number) {
    let temp = qty;
    for (const [price, PriceLevel] of Object.entries(bookWithBid).sort(([priceA, priceB]) => Number(priceB) - Number(priceA))) {
        if (Number(price) >= priceAsked) {
            if (qty >= PriceLevel.totalQty) {
                PriceLevel.totalQty = 0;
                PriceLevel.Order.forEach((order) => {
                    prisma.fills.create({
                        data: {
                            stockId: stock.id,
                            price: Number(price),
                            qty: order.qty,
                            buyOrderId: userId,
                            sellOrderId: order.userId
                        }
                    })

                })

                PriceLevel.Order = [];
                qty -= PriceLevel.totalQty;
            }
            else if (qty) {
                PriceLevel.totalQty -= qty;
                let notCompleteOrder: OrderEntry[] = [];
                PriceLevel.Order.forEach((order) => {
                    if (qty && qty <= order.qty) {
                        prisma.fills.create({
                            data: {
                                stockId: stock.id,
                                price: Number(price),
                                qty: Math.min(qty, order.qty),
                                buyOrderId: userId,
                                sellOrderId: order.userId
                            }
                        })
                        qty -= order.qty;
                    }
                    else if (qty) {
                        prisma.fills.create({
                            data: {
                                stockId: stock.id,
                                price: Number(price),
                                qty,
                                buyOrderId: userId,
                                sellOrderId: order.userId
                            }
                        })
                        notCompleteOrder.push({
                            ...order, qty: order.qty - qty
                        })
                        qty = 0;
                    }
                    else {
                        notCompleteOrder.push(order);
                    }

                })

                PriceLevel.Order = notCompleteOrder;
                PriceLevel.Order = [];
                qty -= PriceLevel.totalQty;
            }
        }
    }
    return temp - qty;
}



function bidLimitOrder(bookWithBid: { [price: number]: PriceLevel }, priceAsked: number, qty: number, stock: stocks, userId: number) {
    let temp = qty;
    for (const [price, PriceLevel] of Object.entries(bookWithBid).sort(([priceA, priceB]) => Number(priceB) - Number(priceA))) {
        if (Number(price) <= priceAsked) {
            if (qty >= PriceLevel.totalQty) {
                PriceLevel.totalQty = 0;
                PriceLevel.Order.forEach((order) => {
                    prisma.fills.create({
                        data: {
                            stockId: stock.id,
                            price: Number(price),
                            qty: order.qty,
                            buyOrderId: userId,
                            sellOrderId: order.userId
                        }
                    })

                })

                PriceLevel.Order = [];
                qty -= PriceLevel.totalQty;
            }
            else if (qty) {
                PriceLevel.totalQty -= qty;
                let notCompleteOrder: OrderEntry[] = [];
                PriceLevel.Order.forEach((order) => {
                    if (qty && qty <= order.qty) {
                        prisma.fills.create({
                            data: {
                                stockId: stock.id,
                                price: Number(price),
                                qty: Math.min(qty, order.qty),
                                buyOrderId: userId,
                                sellOrderId: order.userId
                            }
                        })
                        qty -= order.qty;
                    }
                    else if (qty) {
                        prisma.fills.create({
                            data: {
                                stockId: stock.id,
                                price: Number(price),
                                qty,
                                buyOrderId: userId,
                                sellOrderId: order.userId
                            }
                        })
                        notCompleteOrder.push({
                            ...order, qty: order.qty - qty
                        })
                        qty = 0;
                    }
                    else {
                        notCompleteOrder.push(order);
                    }

                })

                PriceLevel.Order = notCompleteOrder;
                PriceLevel.Order = [];
                qty -= PriceLevel.totalQty;
            }
        }
    }
    return temp - qty;
}


// filledQuantity
function updateORDERBOOKState(type: string, price: number, qty: number, side: string, stock: stocks, userId: number): number {
    const book = ORDERBOOKS[stock.symbol];
    if (!book) return 0;
    if (side === 'ASK') {
        if (type === "market") {
            let filledQty = 0;
            // sorted me loop krna h
            for (const [price, priceLevel] of Object.entries(book["BID"])) {
                if (qty > priceLevel.totalQty) {
                    filledQty += priceLevel.totalQty;
                    clearAllTheOrderForMarketOrder(book["BID"], Number(price), userId, stock, qty);
                }
                else {
                    ReducetheQty(book["BID"], Number(price), userId, stock, qty, qty - filledQty);
                    filledQty = qty;
                }
            }
            return filledQty;
        }
        else {
            return askLimitOrder(book["BID"], price, qty, stock, userId)
        }
    }
    else if (side === 'BID') {
        if (type === "market") {
            let filledQty = 0;
            // sorted me loop krna h
            for (const [price, priceLevel] of Object.entries(book["ASK"])) {
                if (qty > priceLevel.totalQty) {
                    filledQty += priceLevel.totalQty;
                    clearAllTheOrderForMarketOrder(book["ASK"], Number(price), userId, stock, qty);
                }
                else {
                    ReducetheQty(book["ASK"], Number(price), userId, stock, qty, qty - filledQty);
                    filledQty = qty;
                }
            }
            return filledQty;
        }
        else {
            return bidLimitOrder(book["BID"], price, qty, stock, userId)
        }
    }
    return 0;
}


// 500001
app.post("/order", async (req: Request, res: Response) => {
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
        if (type !== 'market' && type !== 'limit') {
            return res.status(400).json({
                success: false,
                message: "the type is not valid"
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
        const symbol: currencyDetailNames = stock.symbol as currencyDetailNames;
        if (!BALANCES[userId]) {
            BALANCES[userId] = { "USD": 0 }
        }
        if (!BALANCES[userId][symbol]) {
            BALANCES[userId][symbol] = 0;
        }
        BALANCES[userId][symbol] += filledQty
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
app.get("/order/:orderId", async (req: Request, res: Response) => {
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


app.delete("/order/:orderId", async (req: Request, res: Response) => {
    try {
        const orderId = Number(req.params.orderId);
        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "missing orderId param"
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


app.get("/depth/:symbol", async (req: Request, res: Response) => {
    try {
        const stockSymbol = req.params.symbol;
        if (!stockSymbol) {
            return res.status(401).json({
                success: false,
                message: "symbol are not present"
            })
        }
        if (typeof stockSymbol !== "string") {
            return res.status(401).json({
                success: false,
                message: "symbol is not in valid format"
            })
        }
        if (stockSymbol in Object.keys(ORDERBOOKS)) { }
        {
            return res.status(201).json({
                success: false,
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
app.get("/orders", async (req: Request, res: Response) => {
    try {
        const { userId } = req;
        const orders = await prisma.order.findMany({
            where: {
                userId
            }
        });
        return res.status(201).json({
            success: true,
            orders
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
});
app.get("/fills", async (req: Request, res: Response) => {
    try {
        const { userId } = req;
        const orders = await prisma.fills.findMany({
            where: {
                OR: [
                    { buyOrderId: userId },
                    { sellOrderId: userId }
                ]
            }
        })

        return res.status(201).json({
            success: true,
            orders
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
});

app.get("/balance/usd", async (req: Request, res: Response) => {
try {
    const {userId} = req;
    if(!userId){
        return res.status(400).json({
            success:false,
            message: "userId is missing"
        })
    }

    return res.status(201).json({
        success:true,
        usdBalance: BALANCES[userId]?.['USD']
    })
} catch (error) {
    return res.status(500).json({
        success:false,
        message: "Server side error"
    })
}
});

/*  
    Returns the balance of all stocks
*/
app.get("/balance", async (req: Request, res: Response) => {
    try {
        const { userId } = req;
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "user is not logged In"
            })
        }
        return res.status(201).json({
            success: true,
            balance: BALANCES[userId]
        })
    } catch (error) {
        return res.status(500).json({
            sucess: false,
            message: "Server side error"
        })
    }

})

app.listen(3000, () => {
    console.log("tmkc")
});