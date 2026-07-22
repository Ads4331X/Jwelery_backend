-- CreateTable
CREATE TABLE `pending_payments` (
    `id` VARCHAR(191) NOT NULL,
    `transactionUuid` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `items` TEXT NOT NULL,
    `addressData` TEXT NOT NULL,
    `addressId` VARCHAR(191) NULL,
    `computedData` TEXT NOT NULL,
    `totalAmount` DECIMAL(12, 2) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `pending_payments_transactionUuid_key`(`transactionUuid`),
    INDEX `pending_payments_userId_idx`(`userId`),
    INDEX `pending_payments_transactionUuid_idx`(`transactionUuid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
