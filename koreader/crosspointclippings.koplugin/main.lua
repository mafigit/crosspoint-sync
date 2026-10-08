--[[--
CrossPoint clippings: two-way highlight sync between KOReader and a CrossPoint Sync server.

* Credentials, server URL and book-matching method are read from KOReader's Progress sync
  plugin, so the same account is used and books get the same document id as on CrossPoint.
* KOReader highlights are uploaded with spine + text (portable anchors every client reads)
  plus their exact xpointers (xpath_start/xpath_end, supported by the forked server).
* Clippings from other devices are placed by their xpointers when available, otherwise by
  searching their text inside the right chapter. Resolved xpointers are written back so other
  KOReader devices don't have to search again.

Only reflowable documents (EPUB, FB2, …) are supported.
]]

local DataStorage = require("datastorage")
local Device = require("device")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local LuaSettings = require("luasettings")
local NetworkMgr = require("ui/network/manager")
local Notification = require("ui/widget/notification")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local http = require("socket.http")
local logger = require("logger")
local ltn12 = require("ltn12")
local rapidjson = require("rapidjson")
local sha2 = require("ffi/sha2")
local socket = require("socket")
local socketutil = require("socketutil")
local util = require("util")
local T = require("ffi/util").template
local _ = require("gettext")

local STATE_KEY = "crosspoint_clippings"
local PAGE_LIMIT = 100
local BATCH = 50
local MAX_TEXT = 4096
local KNOWN_COLORS = {
    red = true, orange = true, yellow = true, green = true, olive = true,
    cyan = true, blue = true, purple = true, gray = true,
}

local CrossPointClippings = WidgetContainer:extend{
    name = "crosspointclippings",
    is_doc_only = true,
    settings_file = DataStorage:getSettingsDir() .. "/crosspointclippings.lua",
}

-- helpers ------------------------------------------------------------------------------------

local function isNull(v)
    return v == nil or v == rapidjson.null
end

local function nn(v) -- JSON null -> nil
    if isNull(v) then return nil end
    return v
end

local function truncateUtf8(s, max_bytes)
    if not s or #s <= max_bytes then return s end
    local cut = max_bytes
    -- step back over UTF-8 continuation bytes (10xxxxxx)
    while cut > 0 and bit.band(s:byte(cut + 1) or 0, 0xC0) == 0x80 do
        cut = cut - 1
    end
    return s:sub(1, cut)
end

local function datetimeToUnix(dt)
    if type(dt) ~= "string" then return 0 end
    local y, mo, d, h, mi, s = dt:match("^(%d+)-(%d+)-(%d+) (%d+):(%d+):(%d+)")
    if not y then return 0 end
    return os.time{ year = tonumber(y), month = tonumber(mo), day = tonumber(d),
                    hour = tonumber(h), min = tonumber(mi), sec = tonumber(s) } or 0
end

local function clippingId(created_at, text)
    return sha2.sha256(tostring(created_at) .. text):sub(1, 16)
end

local function spineFromXPointer(xp)
    local n = type(xp) == "string" and xp:match("^/body/DocFragment%[(%d+)%]")
    return n and (tonumber(n) - 1) or 0
end

-- CrossInk's positional fields. A PUT replaces the whole row, so these must be echoed back
-- unchanged when KOReader updates a clipping that came from a CrossInk device.
local POS_FIELDS = { "spine", "start_page", "end_page", "pages", "start_word", "end_word", "words",
                     "para", "layout_signature", "start_offset", "end_offset" }

local function extractPos(r)
    local pos, any = {}, false
    for _, k in ipairs(POS_FIELDS) do
        if not isNull(r[k]) then pos[k] = r[k]; any = true end
    end
    return any and pos or nil
end

-- Soft hyphen, NBSP, em space, narrow NBSP (CrossInk drops/flattens these), curly quotes, dashes, ellipsis.
local LOOSE_UTF8 = { "\194\173", "\194\160", "\226\128\131", "\226\128\175", "\226\128[\152-\159]",
                     "\226\128[\144-\149]", "\226\128\166" }

local function normalize(s)
    -- Compare text loosely: drop whitespace and punctuation, lowercase ASCII.
    s = s or ""
    for _, p in ipairs(LOOSE_UTF8) do s = s:gsub(p, "") end
    return (s:gsub("[%s%p]", ""):lower())
end

local function splitWords(s)
    local words = {}
    for w in s:gmatch("%S+") do table.insert(words, w) end
    return words
end

-- settings & lifecycle -----------------------------------------------------------------------

function CrossPointClippings:init()
    self.settings = LuaSettings:open(self.settings_file)
    self.ui.menu:registerToMainMenu(self)
end

function CrossPointClippings:kosyncSettings()
    -- Prefer the live Progress sync instance (has fresh, possibly unflushed settings).
    if self.ui.kosync and type(self.ui.kosync.settings) == "table" then
        return self.ui.kosync.settings
    end
    local s = LuaSettings:open(DataStorage:getSettingsDir() .. "/kosync.lua")
    return s:readSetting("settings") or {}
end

function CrossPointClippings:addToMainMenu(menu_items)
    menu_items.crosspoint_clippings = {
        text = _("CrossPoint clippings"),
        sorting_hint = "tools",
        sub_item_table = {
            {
                text = _("Sync clippings now"),
                callback = function()
                    NetworkMgr:runWhenOnline(function() self:sync(true) end)
                end,
            },
            {
                text = _("Sync when opening a book"),
                checked_func = function() return self.settings:isTrue("sync_on_open") end,
                callback = function() self.settings:flipNilOrFalse("sync_on_open"); self.settings:flush() end,
            },
            {
                text = _("Sync when closing a book"),
                checked_func = function() return self.settings:isTrue("sync_on_close") end,
                callback = function() self.settings:flipNilOrFalse("sync_on_close"); self.settings:flush() end,
            },
            {
                text = _("Reset sync state for this book"),
                keep_menu_open = true,
                separator = true,
                callback = function()
                    self.ui.doc_settings:delSetting(STATE_KEY)
                    UIManager:show(Notification:new{ text = _("Sync state reset. Next sync starts fresh.") })
                end,
            },
            {
                text = _("Help"),
                keep_menu_open = true,
                callback = function()
                    UIManager:show(InfoMessage:new{ text = _([[Uses the server, account and document matching method from Tools → Progress sync. Point Progress sync at your CrossPoint Sync server and log in there first.

Use the same matching method (binary is recommended) on every device, KOReader and CrossPoint alike.]]) })
                end,
            },
        },
    }
end

function CrossPointClippings:onReaderReady()
    if not self.settings:isTrue("sync_on_open") then return end
    -- WiFi is usually off when a book opens (Kindle): bring it up per the user's WiFi setting and sync then,
    -- as Progress sync does, instead of skipping the sync.
    if NetworkMgr.willRerunWhenOnline and NetworkMgr:willRerunWhenOnline(function() self:onReaderReady() end) then
        return
    end
    if NetworkMgr:isOnline() then
        UIManager:nextTick(function() self:sync(false) end)
    end
end

function CrossPointClippings:onCloseDocument()
    if self.settings:isTrue("sync_on_close") and NetworkMgr:isOnline() then
        if self:sync(false) then
            -- ReaderUI already saved settings before CloseDocument: persist our changes.
            self.ui.doc_settings:saveSetting("annotations", self.ui.annotation.annotations)
            self.ui.doc_settings:flush()
        end
    end
end

-- HTTP ---------------------------------------------------------------------------------------

function CrossPointClippings:request(method, path, body)
    local sink = {}
    local req = {
        url = self.base_url .. path,
        method = method,
        sink = ltn12.sink.table(sink),
        headers = {
            ["Accept"] = "application/vnd.koreader.v1+json",
            ["x-auth-user"] = self.username,
            ["x-auth-key"] = self.userkey,
        },
    }
    if body then
        local json = rapidjson.encode(body)
        req.source = ltn12.source.string(json)
        req.headers["Content-Type"] = "application/json"
        req.headers["Content-Length"] = #json
    end
    socketutil:set_timeout(socketutil.LARGE_BLOCK_TIMEOUT, socketutil.LARGE_TOTAL_TIMEOUT)
    local code, _headers, status = socket.skip(1, http.request(req))
    socketutil:reset_timeout()
    local text = table.concat(sink)
    if code ~= 200 then
        logger.warn("CrossPointClippings:", method, path, code, status, text)
        return nil, T(_("Server error: %1"), status or code or _("network unreachable"))
    end
    local decoded = rapidjson.decode(text)
    if not decoded then return nil, _("Invalid response from server") end
    return decoded
end

-- local annotations --------------------------------------------------------------------------

function CrossPointClippings:localHighlights()
    local by_id = {}
    for _, a in ipairs(self.ui.annotation.annotations) do
        if a.drawer and type(a.pos0) == "string" and type(a.pos1) == "string" and a.text and a.text ~= "" then
            if not a.cps_id then
                a.cps_id = clippingId(datetimeToUnix(a.datetime), truncateUtf8(a.text, MAX_TEXT))
            end
            by_id[a.cps_id] = a
        end
    end
    return by_id
end

function CrossPointClippings:toWire(a)
    local text = truncateUtf8(a.text, MAX_TEXT)
    local wire = {
        id = a.cps_id,
        spine = spineFromXPointer(a.pos0),
        text = text,
        chapter = a.chapter,
        note = a.note and truncateUtf8(a.note, MAX_TEXT) or rapidjson.null,
        color = a.color or rapidjson.null,
        created_at = datetimeToUnix(a.datetime),
        xpath_start = a.pos0,
        xpath_end = a.pos1,
    }
    if type(a.cps_pos) == "table" then
        for k, v in pairs(a.cps_pos) do wire[k] = v end
    end
    return wire
end

function CrossPointClippings:findAnnotationIndex(item)
    for i, a in ipairs(self.ui.annotation.annotations) do
        if a == item then return i end
    end
end

-- placing remote clippings ---------------------------------------------------------------------

function CrossPointClippings:validPair(s, e)
    local doc = self.ui.document
    return type(s) == "string" and type(e) == "string"
        and doc:isXPointerInDocument(s) and doc:isXPointerInDocument(e)
end

function CrossPointClippings:search(pattern)
    self._search_cache = self._search_cache or {}
    if not self._search_cache[pattern] then
        local ok, res = pcall(self.ui.document.findAllText, self.ui.document, pattern, true, 1, 500, false)
        self._search_cache[pattern] = (ok and res) or {}
    end
    return self._search_cache[pattern]
end

-- Search patterns for one end of a clipping: up to 6 words from its first (or last) paragraph, longest first.
-- CrossInk ends a paragraph with "\n", and KOReader's search does not cross paragraphs. Shorter patterns step
-- around what a literal search misses: CrossInk turns non-breaking spaces into plain spaces, for one.
local function endPatterns(text, from_end)
    local paragraphs = {}
    for line in text:gmatch("[^\n]+") do
        if line:find("%S") then table.insert(paragraphs, line) end
    end
    local words = splitWords(paragraphs[from_end and #paragraphs or 1] or "")
    local patterns = {}
    for n = math.min(6, #words), 1, -1 do
        if from_end then
            table.insert(patterns, table.concat(words, " ", #words - n + 1, #words))
        else
            table.insert(patterns, table.concat(words, " ", 1, n))
        end
    end
    return patterns
end

--- Finds the clipping's text, in its chapter first, then anywhere in the book (the reader's spine index can be
--- off from KOReader's DocFragment numbering, e.g. around non-linear items). Returns pos0, pos1 or nil.
function CrossPointClippings:locate(r)
    local text = nn(r.text)
    if not text or not text:find("%S") then return end
    local doc = self.ui.document
    local want = normalize(text)
    if want == "" then return end
    local heads, tails = endPatterns(text, false), endPatterns(text, true)
    local spine = tonumber(nn(r.spine))
    local frag = spine and ("/body/DocFragment[" .. (spine + 1) .. "]/") or nil

    local function matches(s, e)
        local got = doc:getTextFromXPointers(s, e)
        return got and normalize(got) == want, got and #normalize(got) > #want
    end

    local ends = {}
    local function sortedEnds(pattern)
        if not ends[pattern] then
            local list = {}
            for _, t in ipairs(self:search(pattern)) do
                if t["end"] then table.insert(list, t["end"]) end
            end
            table.sort(list, function(a, b) return doc:compareXPointers(a, b) == 1 end)
            ends[pattern] = list
        end
        return ends[pattern]
    end

    local function find(in_frag)
        for _, head in ipairs(heads) do
            for _, h in ipairs(self:search(head)) do
                if h.start and (not in_frag or h.start:sub(1, #in_frag) == in_frag) then
                    if h["end"] and matches(h.start, h["end"]) then return h.start, h["end"] end
                    for _, tail in ipairs(tails) do
                        -- nearest end after the start first; past the clipping's length no later end can match
                        for _, e in ipairs(sortedEnds(tail)) do
                            if doc:compareXPointers(h.start, e) == 1 then
                                local ok, too_long = matches(h.start, e)
                                if ok then return h.start, e end
                                if too_long then break end
                            end
                        end
                    end
                end
            end
        end
    end

    local pos0, pos1 = find(frag)
    if not pos0 and frag then pos0, pos1 = find(nil) end
    return pos0, pos1
end

function CrossPointClippings:addLocal(r, pos0, pos1)
    local color = nn(r.color)
    local item = {
        page = pos0,
        pos0 = pos0,
        pos1 = pos1,
        text = nn(r.text),
        note = nn(r.note),
        chapter = nn(r.chapter) or self.ui.toc:getTocTitleByPage(pos0),
        -- Older CrossInk firmware sent seconds since boot: date those by their arrival instead of 1970.
        datetime = os.date("%Y-%m-%d %H:%M:%S", (tonumber(nn(r.created_at)) or 0) >= 978307200 and r.created_at or os.time()),
        drawer = self.view.highlight.saved_drawer or "lighten",
        color = KNOWN_COLORS[color] and color or self.view.highlight.saved_color,
        cps_id = r.id,
        cps_pos = extractPos(r),
    }
    local index = self.ui.annotation:addItem(item)
    self.ui:handleEvent(Event:new("AnnotationsModified", { item, nb_highlights_added = 1, index_modified = index }))
    return item
end

-- sync ---------------------------------------------------------------------------------------

function CrossPointClippings:sync(interactive)
    local function fail(msg)
        logger.warn("CrossPointClippings: sync failed:", msg)
        if interactive then UIManager:show(InfoMessage:new{ text = msg }) end
        return false
    end

    if not self.ui.rolling or not self.ui.annotation then
        return fail(_("CrossPoint clippings only supports reflowable documents (EPUB, FB2, …)."))
    end
    local ks = self:kosyncSettings()
    if not ks.username or not ks.userkey then
        return fail(_("Log in under Tools → Progress sync first."))
    end
    if not ks.custom_server then
        return fail(_("Set a custom sync server (your CrossPoint Sync server) under Tools → Progress sync."))
    end
    self.base_url = ks.custom_server:gsub("/+$", "")
    self.username, self.userkey = ks.username, ks.userkey

    local document
    if ks.checksum_method == 1 then -- filename
        local _, file_name = util.splitFilePathName(self.ui.document.file)
        document = sha2.md5(file_name)
    else
        document = self.ui.doc_settings:readSetting("partial_md5_checksum")
            or util.partialMD5(self.ui.document.file)
    end
    if not document then return fail(_("Could not compute document id.")) end

    if self.xpath_supported == nil then
        local health = self:request("GET", "/healthz")
        self.xpath_supported = false
        if health and type(health.features) == "table" then
            for _, f in ipairs(health.features) do
                if f == "clipping_xpath" then self.xpath_supported = true end
            end
        end
        logger.info("CrossPointClippings: server xpath support:", self.xpath_supported)
    end

    local info
    if interactive then
        info = InfoMessage:new{ text = _("Syncing clippings…") }
        UIManager:show(info)
        UIManager:forceRePaint()
    end
    local ok, result = pcall(self._doSync, self, document)
    if info then UIManager:close(info) end
    self._search_cache = nil
    if not ok then return fail(tostring(result)) end
    if result.error then return fail(result.error) end

    UIManager:setDirty(self.view.dialog, "ui")
    if interactive or result.added + result.removed + result.updated > 0 then
        local msg = T(_("Clippings synced: %1 added, %2 removed, %3 updated, %4 uploaded."),
            result.added, result.removed, result.updated, result.pushed)
        if result.unresolved > 0 then
            msg = msg .. "\n" .. T(_("%1 could not be placed in this book yet."), result.unresolved)
        end
        UIManager:show(Notification:new{ text = msg })
    end
    return true
end

function CrossPointClippings:_doSync(document)
    local st = self.ui.doc_settings:readSetting(STATE_KEY) or {}
    st.cursor = st.cursor or 0
    st.known = st.known or {}            -- id -> { note = ..., color = ... } as last agreed
    st.unresolved = st.unresolved or {}  -- id -> remote item we could not place yet
    local out = { added = 0, removed = 0, updated = 0, pushed = 0, unresolved = 0 }

    local local_by_id = self:localHighlights()
    local writeback = {}

    -- 1. pull everything changed since our cursor
    local remote = {}
    local cursor, more = st.cursor, true
    while more do
        local res, err = self:request("GET", T("/api/v1/clippings/%1?cursor=%2&limit=%3", document, cursor, PAGE_LIMIT))
        if not res then return { error = err } end
        for _, r in ipairs(res.items or {}) do
            if r.id then remote[r.id] = r end
        end
        more = res.more == true
        local next_cursor = tonumber(nn(res.cursor))
        if not next_cursor or next_cursor <= cursor then more = false end
        cursor = next_cursor or cursor
    end
    for id, r in pairs(st.unresolved) do
        if not remote[id] then remote[id] = r end
    end

    -- 2. apply remote changes
    for id, r in pairs(remote) do
        local la = local_by_id[id]
        if r.deleted == 1 or r.deleted == true then
            if la then
                local idx = self:findAnnotationIndex(la)
                if idx then self.ui.bookmark:removeItemByIndex(idx) end
                local_by_id[id] = nil
                out.removed = out.removed + 1
            end
            st.known[id], st.unresolved[id] = nil, nil
        elseif la then
            st.unresolved[id] = nil
            if not la.cps_pos then la.cps_pos = extractPos(r) end
            local known = st.known[id]
            local rnote, rcolor = nn(r.note), nn(r.color)
            if known then
                if la.note == known.note and rnote ~= known.note then
                    la.note = rnote
                    out.updated = out.updated + 1
                end
                if la.color == known.color and rcolor ~= known.color and KNOWN_COLORS[rcolor] then
                    la.color = rcolor
                    out.updated = out.updated + 1
                end
            else
                st.known[id] = { note = la.note, color = la.color }
                writeback[id] = true
            end
            if self.xpath_supported and isNull(r.xpath_start) then writeback[id] = true end
        elseif st.known[id] then
            -- deleted here since the last sync: step 3 sends the tombstone
        else
            local pos0, pos1 = nn(r.xpath_start), nn(r.xpath_end)
            if not self:validPair(pos0, pos1) then
                pos0, pos1 = self:locate(r)
                if pos0 then writeback[id] = self.xpath_supported or nil end
            end
            if pos0 then
                local item = self:addLocal(r, pos0, pos1)
                local_by_id[id] = item
                st.known[id] = { note = item.note, color = item.color }
                st.unresolved[id] = nil
                out.added = out.added + 1
            else
                -- store without JSON nulls: they can't be serialized into doc settings
                local keep = extractPos(r) or {}
                keep.id, keep.text, keep.note = id, nn(r.text), nn(r.note)
                keep.color, keep.chapter, keep.created_at = nn(r.color), nn(r.chapter), nn(r.created_at)
                st.unresolved[id] = keep
            end
        end
    end

    -- 3. push local changes, new highlights and deletions
    local batch = {}
    for id, a in pairs(local_by_id) do
        local known = st.known[id]
        if not known or writeback[id] or known.note ~= a.note or known.color ~= a.color then
            table.insert(batch, self:toWire(a))
        end
    end
    for id in pairs(st.known) do
        if not local_by_id[id] then
            table.insert(batch, { id = id, deleted = 1 })
        end
    end
    for i = 1, #batch, BATCH do
        local chunk = { unpack(batch, i, math.min(i + BATCH - 1, #batch)) }
        local res, err = self:request("PUT", "/api/v1/clippings/" .. document, { items = chunk })
        if not res then
            self.ui.doc_settings:saveSetting(STATE_KEY, st)
            return { error = err }
        end
        for _, w in ipairs(chunk) do
            if w.deleted then
                st.known[w.id] = nil
            else
                local a = local_by_id[w.id]
                st.known[w.id] = { note = a.note, color = a.color }
                out.pushed = out.pushed + 1
            end
        end
    end

    for _ in pairs(st.unresolved) do out.unresolved = out.unresolved + 1 end
    st.cursor = cursor
    self.ui.doc_settings:saveSetting(STATE_KEY, st)
    return out
end

return CrossPointClippings
