-- Language of a script job. Cloudflare runs "javascript" only; the Docker sandbox also runs "python" and "go".
ALTER TABLE jobs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'javascript';
