-- Lock Parking Bot - D1 Schema
-- A booking represents a parking assignment for a date range.
-- checkin = first night parked, checkout = day they leave (spot free for new arrival)

CREATE TABLE IF NOT EXISTS parking_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_name TEXT NOT NULL,
    checkin TEXT NOT NULL,  -- ISO date: YYYY-MM-DD
    checkout TEXT NOT NULL, -- ISO date: YYYY-MM-DD
    created_at TEXT DEFAULT (datetime('now')),
    notes TEXT
);

-- Index for fast overlap queries
CREATE INDEX IF NOT EXISTS idx_parking_dates ON parking_bookings(checkin, checkout);
