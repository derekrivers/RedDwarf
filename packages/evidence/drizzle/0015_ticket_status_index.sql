-- Add index on ticket_specs.status for efficient status-based queries
CREATE INDEX IF NOT EXISTS idx_ticket_specs_status ON ticket_specs(status);
