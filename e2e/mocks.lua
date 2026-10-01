-- Minimal KOReader mocks for running the plugin headless.
local cjson = require("cjson")
local M = {}
local function mod(name, v) package.preload[name] = function() return v end end

mod("rapidjson", { null = cjson.null, encode = cjson.encode, decode = function(s) local ok, v = pcall(cjson.decode, s); return ok and v or nil end })
mod("datastorage", { getSettingsDir = function() return "/tmp/kosettings" end })
mod("device", {})
mod("ui/event", { new = function(_, name, args) return { name = name, args = args } end })
M.shown = {}
local Widget = { new = function(cls, o) return o end }
mod("ui/widget/infomessage", Widget)
mod("ui/widget/notification", Widget)
mod("ui/uimanager", {
  show = function(_, w) table.insert(M.shown, w.text) end, close = function() end,
  forceRePaint = function() end, setDirty = function() end, nextTick = function(_, f) f() end })
mod("ui/network/manager", { isOnline = function() return true end, runWhenOnline = function(_, f) f() end })
local Settings = {}
Settings.__index = Settings
function Settings:readSetting(k) return self.data[k] end
function Settings:saveSetting(k, v) self.data[k] = v end
function Settings:delSetting(k) self.data[k] = nil end
function Settings:isTrue(k) return self.data[k] == true end
function Settings:flipNilOrFalse(k) self.data[k] = not self.data[k] end
function Settings:flush() end
M.newSettings = function() return setmetatable({ data = {} }, Settings) end
mod("luasettings", { open = function() return M.newSettings() end })
mod("ui/widget/container/widgetcontainer", { extend = function(_, o) o.__index = o; o.new = function(cls, inst) return setmetatable(inst, cls) end; return o end })
mod("logger", { warn = function(...) print("WARN", ...) end, info = function() end, dbg = function() end })
mod("socketutil", { set_timeout = function() end, reset_timeout = function() end, LARGE_BLOCK_TIMEOUT = 10, LARGE_TOTAL_TIMEOUT = 30 })
mod("util", { splitFilePathName = function(p) return p:match("(.*/)(.*)") end, partialMD5 = function() return "deadbeefdeadbeefdeadbeefdeadbeef" end })
mod("ffi/util", { template = function(s, ...) local a = {...}; return (s:gsub("%%(%d)", function(i) return tostring(a[tonumber(i)]) end)) end })
mod("gettext", function(s) return s end)

-- Fake book: fragments of paragraphs. XPointer: /body/DocFragment[F]/body/p[P]/text().O (O = 0-based byte offset)
M.book = {
  { "Chapter one begins here.", "It was a bright cold day in April, and the clocks were striking thirteen." },
  { "Chapter two.", "So we beat on, boats against the current, borne back ceaselessly into the past.",
    "Whereof one cannot speak, thereof one must be silent." },
}
local function xp(f, p, o) return string.format("/body/DocFragment[%d]/body/p[%d]/text().%d", f, p, o) end
local function parse(x)
  local f, p, o = x:match("^/body/DocFragment%[(%d+)%]/body/p%[(%d+)%]/text%(%)%.(%d+)$")
  if f then return tonumber(f), tonumber(p), tonumber(o) end
end
M.xp = xp
M.document = {
  file = "/books/test.epub",
  isXPointerInDocument = function(_, x)
    local f, p, o = parse(x); return f and M.book[f] and M.book[f][p] and o <= #M.book[f][p] or false end,
  compareXPointers = function(_, a, b)
    local fa, pa, oa = parse(a); local fb, pb, ob = parse(b)
    local ka, kb = fa * 1e8 + pa * 1e4 + oa, fb * 1e8 + pb * 1e4 + ob
    return ka < kb and 1 or (ka == kb and 0 or -1) end,
  getTextFromXPointers = function(_, a, b)
    local fa, pa, oa = parse(a); local fb, pb, ob = parse(b)
    if fa ~= fb then return nil end
    local out = {}
    for p = pa, pb do
      local t = M.book[fa][p]
      local s = (p == pa) and oa + 1 or 1
      local e = (p == pb) and ob or #t
      table.insert(out, t:sub(s, e))
    end
    return table.concat(out, "\n") end,
  findAllText = function(_, pattern, ci)
    local res, pat = {}, pattern:lower()
    for f, paras in ipairs(M.book) do for p, t in ipairs(paras) do
      local i = t:lower():find(pat, 1, true)
      if i then table.insert(res, { start = xp(f, p, i - 1), ["end"] = xp(f, p, i - 1 + #pattern) }) end
    end end
    return res end,
}
return M
