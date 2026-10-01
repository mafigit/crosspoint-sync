-- KOReader-native anchors for clippings. CrossInk devices keep using spine/para/offsets;
-- KOReader clients store their exact pos0/pos1 xpointers here. Both coexist on one row.
ALTER TABLE clippings ADD COLUMN xpath_start TEXT;
ALTER TABLE clippings ADD COLUMN xpath_end TEXT;
