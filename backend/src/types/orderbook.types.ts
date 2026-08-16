export type OrderEntry = {
    userId: number,
    qty: number,
    filledQty: number,
    orderId: number,
}

export type PriceLevel = {
    totalQty: number,
    Order: OrderEntry[]
}

export type stockOrderBook = {
    ASK: { [price: number]: PriceLevel },
    BID: { [price: number]: PriceLevel }
}

export type OrderBook = {
    [symbol: string]: stockOrderBook
}
