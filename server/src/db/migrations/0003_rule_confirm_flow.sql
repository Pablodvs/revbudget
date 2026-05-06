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
	`type` text DEFAULT 'expense' NOT NULL,
	`related_tx_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`related_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "status_check" CHECK("__new_transactions"."status" IN ('pending','pending_confirmation','classified','ignored')),
	CONSTRAINT "amount_positive" CHECK("__new_transactions"."amount" > 0),
	CONSTRAINT "type_check" CHECK("__new_transactions"."type" IN ('expense','income','refund','adjustment'))
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "wallet_id", "amount", "currency", "merchant", "merchant_display", "description", "raw_text", "status", "telegram_message_id", "classified_at", "transaction_date", "type", "related_tx_id", "created_at", "updated_at") SELECT "id", "wallet_id", "amount", "currency", "merchant", "merchant_display", "description", "raw_text", "status", "telegram_message_id", "classified_at", "transaction_date", "type", "related_tx_id", "created_at", "updated_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tx_status` ON `transactions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tx_wallet` ON `transactions` (`wallet_id`);--> statement-breakpoint
CREATE INDEX `idx_tx_date` ON `transactions` (`transaction_date`);--> statement-breakpoint
CREATE INDEX `idx_tx_type` ON `transactions` (`type`);--> statement-breakpoint
ALTER TABLE `merchant_rules` ADD `require_confirmation` integer DEFAULT true NOT NULL;