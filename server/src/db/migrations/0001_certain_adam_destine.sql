CREATE TABLE `parse_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`raw_text` text NOT NULL,
	`error_code` text NOT NULL,
	`received_at` text NOT NULL,
	`telegram_message_id` integer,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "error_code_check" CHECK("parse_failures"."error_code" IN ('empty','no_match','invalid_amount'))
);
--> statement-breakpoint
CREATE INDEX `idx_pf_resolved` ON `parse_failures` (`resolved_at`);--> statement-breakpoint
INSERT INTO `parse_failures` (`raw_text`, `error_code`, `received_at`, `telegram_message_id`, `resolved_at`)
SELECT `raw_text`,
       REPLACE(`description`, 'parse_failed:', ''),
       `transaction_date`,
       `telegram_message_id`,
       CASE WHEN `status` = 'classified' THEN `classified_at`
            WHEN `status` = 'ignored' THEN `updated_at`
            ELSE NULL END
FROM `transactions`
WHERE `description` LIKE 'parse_failed:%';--> statement-breakpoint
DELETE FROM `transactions` WHERE `description` LIKE 'parse_failed:%';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` integer,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`merchant` text NOT NULL,
	`merchant_display` text NOT NULL,
	`description` text,
	`raw_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`telegram_message_id` integer,
	`classified_at` text,
	`transaction_date` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "status_check" CHECK("status" IN ('pending','classified','ignored')),
	CONSTRAINT "amount_positive" CHECK("amount" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "wallet_id", "amount", "currency", "merchant", "merchant_display", "description", "raw_text", "status", "telegram_message_id", "classified_at", "transaction_date", "created_at", "updated_at") SELECT "id", "wallet_id", "amount", "currency", "merchant", "merchant_display", "description", "raw_text", "status", "telegram_message_id", "classified_at", "transaction_date", "created_at", "updated_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tx_status` ON `transactions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tx_wallet` ON `transactions` (`wallet_id`);--> statement-breakpoint
CREATE INDEX `idx_tx_date` ON `transactions` (`transaction_date`);