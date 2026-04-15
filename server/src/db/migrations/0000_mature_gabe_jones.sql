CREATE TABLE `budget_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` integer NOT NULL,
	`month` text NOT NULL,
	`budget_override` integer,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_periods_wallet_month_unique` ON `budget_periods` (`wallet_id`,`month`);--> statement-breakpoint
CREATE TABLE `merchant_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`wallet_id` integer NOT NULL,
	`match_type` text DEFAULT 'exact' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "match_type_check" CHECK("merchant_rules"."match_type" IN ('exact','contains'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_rules_pattern_unique` ON `merchant_rules` (`pattern`);--> statement-breakpoint
CREATE TABLE `transactions` (
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
	CONSTRAINT "status_check" CHECK("transactions"."status" IN ('pending','classified','ignored'))
);
--> statement-breakpoint
CREATE INDEX `idx_tx_status` ON `transactions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tx_wallet` ON `transactions` (`wallet_id`);--> statement-breakpoint
CREATE INDEX `idx_tx_date` ON `transactions` (`transaction_date`);--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`budget` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`color` text NOT NULL,
	`icon` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
