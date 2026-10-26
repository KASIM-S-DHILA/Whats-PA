-- Records whether a shadow decision came from chat or from a live call. Routing metadata only, existing rows are chat.
ALTER TABLE memory_shadow_log ADD COLUMN channel TEXT NOT NULL DEFAULT 'chat' CHECK(channel IN ('chat','call'));
