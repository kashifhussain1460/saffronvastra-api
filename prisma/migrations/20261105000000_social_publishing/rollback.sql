-- rollback.sql: drops all 6 social tables in reverse FK order
DROP TABLE IF EXISTS social_publish_logs;
DROP TABLE IF EXISTS social_publish_jobs;
DROP TABLE IF EXISTS social_post_variants;
DROP TABLE IF EXISTS social_campaign_products;
DROP TABLE IF EXISTS social_campaigns;
DROP TABLE IF EXISTS social_accounts;
