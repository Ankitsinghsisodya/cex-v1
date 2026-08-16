import { prisma } from "../../util"
import type { stocksModel as stocks } from "../../generated/models"
import type { OrderEntry, PriceLevel, OrderBook } from "../types/orderbook.types"

export type UserBalance = {
    usd: number,
    stocks: { [symbol: string]: number }
}

const STARTING_USD_BALANCE = 10000;

export const BALANCES: { [userId: number]: UserBalance } = {

}

/**
 * Lazily creates (and returns) a starting balance for a user the first time
 * it's needed. This is pure in-memory state, just like ORDERBOOKS — it is
 * never persisted and resets whenever the server restarts. Balances are
 * NOT currently updated by order fills; they only reflect the seeded
 * starting amount.
 */
export function ensureUserBalance(userId: number): UserBalance {
    if (!BALANCES[userId]) {
        BALANCES[userId] = { usd: STARTING_USD_BALANCE, stocks: {} };
    }
    return BALANCES[userId];
}

export const ORDERBOOKS: OrderBook = {
    SOL: {
        ASK: {},
        BID: {}
    },
    BTC: {
        ASK: {},
        BID: {}
    }
}

// 50.01

export function clearAllTheOrderForMarketOrder(bookWithBid: { [price: number]: PriceLevel }, price: number, userId: number, stock: stocks, qty: number) {
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

export function ReducetheQty(bookWithBid: { [price: number]: PriceLevel }, price: number, userId: number, stock: stocks, qty: number, req: number) {
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

export function askLimitOrder(bookWithBid: { [price: number]: PriceLevel }, priceAsked: number, qty: number, stock: stocks, userId: number) {
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



export function bidLimitOrder(bookWithBid: { [price: number]: PriceLevel }, priceAsked: number, qty: number, stock: stocks, userId: number) {
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
export function updateORDERBOOKState(type: string, price: number, qty: number, side: string, stock: stocks, userId: number): number {
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
