-- Add new fields for sales percentage restrictions
ALTER TABLE "RestrictionRule" 
ADD COLUMN IF NOT EXISTS "baseAmount" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "salesPercentage" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "appliesToVendedor" BOOLEAN NOT NULL DEFAULT false;

-- Create index for salesPercentage queries
CREATE INDEX IF NOT EXISTS "idx_restriction_rules_sales_percentage" 
  ON "RestrictionRule"("salesPercentage") 
  WHERE "salesPercentage" IS NOT NULL;

-- Add constraints for data validation
ALTER TABLE "RestrictionRule"
DROP CONSTRAINT IF EXISTS check_sales_percentage_range;

ALTER TABLE "RestrictionRule"
ADD CONSTRAINT check_sales_percentage_range 
CHECK ("salesPercentage" IS NULL OR ("salesPercentage" >= 0 AND "salesPercentage" <= 100));

ALTER TABLE "RestrictionRule"
DROP CONSTRAINT IF EXISTS check_base_amount_positive;

ALTER TABLE "RestrictionRule"
ADD CONSTRAINT check_base_amount_positive 
CHECK ("baseAmount" IS NULL OR "baseAmount" >= 0);






