"""
tests/browser-check.py
Playwright checks that drive the real page (index.html), which loads the
same src/archiveEngine.js that tests/verify.js tests.
Run:  python3 tests/browser-check.py      (expects "0 failed" on the last line)
"""
import functools, http.server, pathlib, threading
from html.parser import HTMLParser
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print(f"PASS: {name}")
    else: failed += 1; print(f"FAIL: {name}")

class Balance(HTMLParser):
    VOID = {"meta","link","br","input","img","hr","source","wbr","col"}
    def __init__(self): super().__init__(); self.stack, self.errors = [], []
    def handle_starttag(self, tag, attrs):
        if tag not in self.VOID: self.stack.append(tag)
    def handle_endtag(self, tag):
        if tag in self.VOID: return
        if not self.stack or self.stack[-1] != tag: self.errors.append(f"unexpected </{tag}> open {self.stack[-3:]}")
        else: self.stack.pop()

print("0. HTML tag balance")
b = Balance(); b.feed((ROOT / "index.html").read_text())
check("all tags closed and nested", not b.errors and not b.stack)
if b.errors: print(b.errors[:5])

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)); handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
problems = []

with sync_playwright() as pw:
    br = pw.chromium.launch()
    p = br.new_page(viewport={"width": 1366, "height": 950})
    p.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    p.on("pageerror", lambda e: problems.append(str(e)))
    p.goto(url); p.wait_for_selector("[data-testid=row]")
    rows = lambda: p.locator("[data-testid=row]").count()
    res = lambda: p.locator("[data-testid=a-res]").inner_text()
    def run(job): p.select_option("[data-testid=a-job]", value=job); p.click("[data-testid=a-run]")

    print("\n1. Bases")
    check("active base shows 5 sales records, 26 records in total", rows() == 5 and "(26)" in p.locator("[data-testid=base-active]").inner_text())
    check("archive base starts with 3 records", "(3)" in p.locator("[data-testid=base-archive]").inner_text())
    check("documents default to J-2052 with current payment due $14,202.50", "$14,202.50" in p.locator("[data-testid=due]").inner_text())
    p.screenshot(path=str(TESTS / "screenshot-default.png"), full_page=False)

    print("\n2. Refusals")
    run("recS2")
    check("in-production job refused", "only Complete jobs" in res() and "(26)" in p.locator("[data-testid=base-active]").inner_text())
    run("recS3")
    check("shared work order stops the archive", "also linked to another active job" in res())
    p.fill("[data-testid=a-limit]", "10"); run("recS1")
    check("archive limit 10 refused before copying", "record limit" in res())
    p.fill("[data-testid=a-limit]", "50000")
    p.check("[data-testid=a-fail]"); run("recS1")
    check("failed write: rolled back, active base still 26", "A write failed" in res() and "(26)" in p.locator("[data-testid=base-active]").inner_text() and "(3)" in p.locator("[data-testid=base-archive]").inner_text())
    check("the log says the copy was rolled back", "rolled back" in p.locator("[data-testid=a-log]").inner_text())
    p.uncheck("[data-testid=a-fail]")

    print("\n3. Archive J-2041")
    run("recS1")
    check("9 records moved and verified", "9 records moved" in res() and "(17)" in p.locator("[data-testid=base-active]").inner_text() and "(12)" in p.locator("[data-testid=base-archive]").inner_text())
    check("J-2041 no longer offered for archiving", p.locator("[data-testid=a-job] option[value=recS1]").count() == 0)
    p.click("[data-testid=base-archive]"); p.click("[data-testid=tbl-production]")
    walnut = p.locator("[data-testid=row]", has_text="WO-3320").inner_text()
    check("in the archive, WO-3320 still links to J-2041 and its estimate line", "J-2041" in walnut and "Walnut wall paneling" in walnut and "recP5" in walnut)
    p.screenshot(path=str(TESTS / "screenshot-archive.png"), full_page=False)
    p.select_option("[data-testid=d-job]", label="J-2041 · Harbor Point Medical (archive)")
    check("documents still generate from the archived job", "Reception desk" in p.locator("[data-testid=sov]").inner_text() and p.locator("[data-testid=sticker]").count() == 5)

    print("\n4. Keep a stub")
    p.click("[data-testid=base-active]"); p.click("[data-testid=tbl-sales]")
    p.select_option("[data-testid=a-mode]", "mark"); run("recS5")
    check("stub mode: Oak and Iron marked Archived, active count unchanged", "Archived" in p.locator("[data-testid=row]", has_text="J-2019").inner_text() and "(17)" in p.locator("[data-testid=base-active]").inner_text())

    print("\n5. Documents")
    p.select_option("[data-testid=d-job]", label="J-2052 · Linden Street Lofts")
    sov = p.locator("[data-testid=sov]").inner_text()
    check("Schedule of Values: kitchen cabinets this period $8,100.00, total $36,600.00", "$8,100.00" in sov and "$36,600.00" in sov)
    check("3 work-order stickers with codes", p.locator("[data-testid=sticker]").count() == 3 and "WO-3401|recP6" in p.locator("[data-testid=stickers]").inner_text())
    p.click("[data-testid=reset]")
    check("reset restores both bases", "(26)" in p.locator("[data-testid=base-active]").inner_text() and "(3)" in p.locator("[data-testid=base-archive]").inner_text())
    p.locator("#app").scroll_into_view_if_needed()
    p.screenshot(path=str(TESTS / "screenshot-app.png"), full_page=False)

    print("\n6. Phone width")
    m = br.new_page(viewport={"width": 390, "height": 844})
    m.on("pageerror", lambda e: problems.append(str(e)))
    m.goto(url); m.wait_for_selector("[data-testid=row]")
    check("no horizontal page scroll at 390px", m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    m.screenshot(path=str(TESTS / "screenshot-mobile.png"), full_page=False)

    print("\n7. Console")
    check("zero console or page errors", not problems)
    if problems: print(problems)
    br.close()
srv.shutdown()
print(f"\n{passed} passed, {failed} failed")
