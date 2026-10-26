ALTER TABLE file_catalog ADD COLUMN meta_media_id TEXT;
ALTER TABLE file_catalog ADD COLUMN meta_media_phone TEXT;
ALTER TABLE file_catalog ADD COLUMN meta_media_sha256 TEXT;
ALTER TABLE file_catalog ADD COLUMN meta_media_expires_at INTEGER NOT NULL DEFAULT 0;
