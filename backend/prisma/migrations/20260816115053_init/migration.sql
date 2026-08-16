-- CreateEnum
CREATE TYPE "Side" AS ENUM ('ASK', 'BID');

-- CreateEnum
CREATE TYPE "Type" AS ENUM ('LIMIT', 'MARKET');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('FILLED', 'PARTIAL', 'EMPTY');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "side" "Side" NOT NULL,
    "type" "Type" NOT NULL,
    "stockId" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "filledQty" INTEGER NOT NULL,
    "status" "Status" NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocks" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fills" (
    "id" SERIAL NOT NULL,
    "stockId" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "buyOrderId" INTEGER NOT NULL,
    "sellOrderId" INTEGER NOT NULL,

    CONSTRAINT "Fills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fills" ADD CONSTRAINT "Fills_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fills" ADD CONSTRAINT "Fills_buyOrderId_fkey" FOREIGN KEY ("buyOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fills" ADD CONSTRAINT "Fills_sellOrderId_fkey" FOREIGN KEY ("sellOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
