package.path = "./?.lua;" .. os.getenv("PLUGIN_DIR") .. "/?.lua;" .. package.path
local M = require("mocks")
local cjson = require("cjson")
local http = require("socket.http")
local ltn12 = require("ltn12")
local sha2 = require("ffi/sha2")
local Plugin = dofile(os.getenv("PLUGIN_DIR") .. "/main.lua")

local USER, KEY = "tester", sha2.md5("pw")
local BASE = "http://localhost:" .. (os.getenv("E2E_PORT") or "18080")
local DOC = "deadbeefdeadbeefdeadbeefdeadbeef"

local function curl(method, path, body)
  local sink, src = {}, body and cjson.encode(body)
  http.request{ url = BASE .. path, method = method, sink = ltn12.sink.table(sink),
    source = src and ltn12.source.string(src),
    headers = { ["x-auth-user"] = USER, ["x-auth-key"] = KEY, ["Content-Type"] = "application/json", ["Content-Length"] = src and #src } }
  return cjson.decode(table.concat(sink))
end
curl("POST", "/users/create", { username = USER, password = KEY })

local function newDevice(name)
  local ui = {
    document = M.document,
    doc_settings = M.newSettings(),
    rolling = true,
    menu = { registerToMainMenu = function() end },
    kosync = { settings = { username = USER, userkey = KEY, custom_server = BASE .. "/", checksum_method = 0 } },
    toc = { getTocTitleByPage = function() return "Chapter" end },
    annotation = { annotations = {} },
    bookmark = {},
  }
  ui.doc_settings:saveSetting("partial_md5_checksum", DOC)
  function ui.annotation:addItem(item) table.insert(self.annotations, item); return #self.annotations end
  function ui.bookmark:removeItemByIndex(i) table.remove(ui.annotation.annotations, i) end
  function ui:handleEvent() end
  local view = { highlight = { saved_drawer = "lighten", saved_color = "yellow" }, dialog = {} }
  local p = Plugin:new{ ui = ui, view = view, name = name }
  p:init()
  return p, ui
end
local function check(cond, msg) print((cond and "PASS " or "FAIL ") .. msg); if not cond then os.exit(1) end end
local function find(ui, text)
  for _, a in ipairs(ui.annotation.annotations) do if a.text == text then return a end end
end

-- Device A: KOReader with one highlight + note
local A, uiA = newDevice("A")
table.insert(uiA.annotation.annotations, {
  drawer = "lighten", color = "yellow", datetime = "2026-09-30 21:15:00",
  pos0 = M.xp(1, 2, 0), pos1 = M.xp(1, 2, 33), page = M.xp(1, 2, 0),
  text = "It was a bright cold day in April", note = "Orwell opening", chapter = "Chapter 1" })
check(A:sync(true), "A pushes its highlight")
local srv = curl("GET", "/api/v1/clippings/" .. DOC)
check(#srv.items == 1 and srv.items[0 + 1].xpath_start == M.xp(1, 2, 0) and srv.items[1].spine == 0, "server stores xpaths and spine 0")

-- CrossInk device: clipping with no xpaths, CrossInk fields only
local crossink = { id = "c0ffee0011223344", spine = 1, para = 2, start_offset = 0, end_offset = 40,
  start_page = 3, end_page = 3, pages = 10, start_word = 0, end_word = 7, words = 15,
  chapter = "Chapter two", text = "So we beat on, boats against the current", created_at = 1790000000 }
curl("PUT", "/api/v1/clippings/" .. DOC, { items = { crossink } })

-- Device B: fresh KOReader, same book
local B, uiB = newDevice("B")
check(B:sync(true), "B syncs")
local hb = find(uiB, "It was a bright cold day in April")
check(hb and hb.pos0 == M.xp(1, 2, 0) and hb.note == "Orwell opening", "B placed A's highlight by xpath, with note")
local cb = find(uiB, crossink.text)
check(cb and cb.pos0 == M.xp(2, 2, 0) and cb.pos1 == M.xp(2, 2, 40), "B placed CrossInk clipping by text search in spine 1")
srv = curl("GET", "/api/v1/clippings/" .. DOC)
local sc; for _, it in ipairs(srv.items) do if it.id == crossink.id then sc = it end end
check(sc.xpath_start == M.xp(2, 2, 0) and sc.para == 2 and sc.start_offset == 0, "B wrote xpaths back, CrossInk fields intact")

-- CrossInk updates its clipping (no xpaths) -> xpaths must survive
curl("PUT", "/api/v1/clippings/" .. DOC, { items = { crossink } })
srv = curl("GET", "/api/v1/clippings/" .. DOC)
for _, it in ipairs(srv.items) do if it.id == crossink.id then sc = it end end
check(sc.xpath_start == M.xp(2, 2, 0), "CrossInk update kept xpaths")

-- B edits note on A's highlight; A pulls it
hb.note = "edited on B"
check(B:sync(true), "B pushes note edit")
check(A:sync(true), "A syncs")
check(find(uiA, "It was a bright cold day in April").note == "edited on B", "A received B's note edit")
check(find(uiA, crossink.text) and find(uiA, crossink.text).pos0 == M.xp(2, 2, 0), "A got CrossInk clipping via written-back xpath")

-- A deletes the highlight; B removes it
for i, a in ipairs(uiA.annotation.annotations) do if a.text == "It was a bright cold day in April" then table.remove(uiA.annotation.annotations, i) break end end
check(A:sync(true), "A pushes deletion")
check(B:sync(true), "B syncs deletion")
check(find(uiB, "It was a bright cold day in April") == nil, "B removed deleted highlight")
srv = curl("GET", "/api/v1/clippings/" .. DOC)
local tomb; for _, it in ipairs(srv.items) do if it.deleted == 1 then tomb = it end end
check(tomb ~= nil, "server holds a tombstone for CrossInk devices")

-- Unplaceable clipping is kept for retry and doesn't break sync
curl("PUT", "/api/v1/clippings/" .. DOC, { items = { { id = "feedfacefeedface", spine = 1, text = "text that is not in this book", created_at = 1 } } })
check(B:sync(true), "B syncs with an unplaceable clipping")
check(B.ui.doc_settings:readSetting("crosspoint_clippings").unresolved["feedfacefeedface"] ~= nil, "unplaceable clipping kept for retry")

-- CrossInk clippings KOReader's literal search can't find in one go
local function crossinkClip(id, spine, text) return { id = id, spine = spine, text = text, created_at = 340 } end
curl("PUT", "/api/v1/clippings/" .. DOC, { items = {
  -- spans two paragraphs (CrossInk joins them with a newline; the search does not cross paragraphs)
  crossinkClip("a1a1a1a1a1a1a1a1", 2, "harbour was quiet.\nSecond paragraph starts here"),
  -- the book has a non-breaking space where CrossInk's text has a plain one
  crossinkClip("b2b2b2b2b2b2b2b2", 2, "The ship sailed at dawn"),
  -- the reader's spine index is off from KOReader's fragments
  crossinkClip("c3c3c3c3c3c3c3c3", 0, "Whereof one cannot speak"),
} })
local C, uiC = newDevice("C")
check(C:sync(true), "C syncs CrossInk clippings")
local multi = find(uiC, "harbour was quiet.\nSecond paragraph starts here")
check(multi and multi.pos0 == M.xp(3, 1, 33) and multi.pos1 == M.xp(3, 2, 28), "C placed a clipping across two paragraphs")
local nbsp = find(uiC, "The ship sailed at dawn")
check(nbsp and nbsp.pos0 == M.xp(3, 1, 0) and nbsp.pos1 == M.xp(3, 1, 24), "C placed a clipping over a non-breaking space")
local shifted = find(uiC, "Whereof one cannot speak")
check(shifted and shifted.pos0 == M.xp(2, 3, 0), "C placed a clipping whose spine index is off")
check(multi.datetime:sub(1, 4) ~= "1970", "a clipping stamped with seconds since boot is not dated 1970")

-- Idempotence: another sync changes nothing
check(B:sync(true), "B catches up with the CrossInk clippings")
local before = #uiB.annotation.annotations
check(B:sync(true) and #uiB.annotation.annotations == before, "repeat sync is idempotent")
-- Sleep/wake: off by default; when on, an offline sleep asks for WiFi and syncs once connected
local W, uiW = newDevice("W")
local srv_before = #curl("GET", "/api/v1/clippings/" .. DOC).items
W:onSuspend()
check(#uiW.annotation.annotations == 0, "sleep/wake sync is off by default")
W.settings:saveSetting("sync_on_suspend_resume", true)
M.offline = true
W:onSuspend()
check(M.wifi_requests == 1 and W.pending_bg_sync and #uiW.annotation.annotations == 0, "offline sleep requests WiFi and waits")
M.offline = false
local saved = 0
function uiW:saveSettings() saved = saved + 1 end
W:onNetworkConnected()
check(not W.pending_bg_sync and #uiW.annotation.annotations > 0 and saved == 1, "sync runs once WiFi is connected and saves")
local n = #uiW.annotation.annotations
W:onResume()
check(saved == 1 and #uiW.annotation.annotations == n, "wake right after sleep is debounced")
W.last_bg_sync = os.time() - 60
W:onResume()
check(saved == 2, "wake syncs when online")
check(#curl("GET", "/api/v1/clippings/" .. DOC).items == srv_before, "background syncs upload nothing new")
print("ALL PASSED")
for _, t in ipairs(M.shown) do print("  ui:", t) end
