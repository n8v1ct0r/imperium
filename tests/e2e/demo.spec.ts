// The wow path: the mission starts on load, the checkpoint fires, and the decision changes
// what the log records. No request leaves the origin (0 ion requests).
import { expect, test, type Page } from "@playwright/test";

function watchHosts(page: Page): Set<string> {
  const hosts = new Set<string>();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http")) hosts.add(u.host);
  });
  return hosts;
}

test("approve: a signed grant is logged, checked in the browser, and a tampered copy fails", async ({
  page,
}) => {
  const hosts = watchHosts(page);
  await page.goto("/");
  await expect(page.locator("[data-honesty-strip]")).toContainText("Simulated");
  const approve = page.getByRole("button", { name: /Approve route deviate for AE-007/ });
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await approve.click();
  const strip = page.getByLabel("Needs you");
  await expect(strip).toContainText("flies the approved route", { timeout: 15_000 });
  await expect(strip).toContainText("Signature checked in this browser: valid.");
  await page.getByRole("button", { name: "Tamper with the grant" }).click();
  await expect(strip).toContainText("the same signature fails");
  await expect(page.locator(".log")).toContainText("minted");
  expect([...hosts]).toEqual(["127.0.0.1:4173"]);
});

test("deny: the denial is logged and no grant is minted", async ({ page }) => {
  await page.goto("/");
  const deny = page.getByRole("button", { name: /Deny route deviate for AE-007/ });
  await expect(deny).toBeVisible({ timeout: 20_000 });
  await deny.click();
  await expect(page.getByLabel("Needs you")).toContainText("holds its search loop", {
    timeout: 15_000,
  });
  await expect(page.locator(".log")).toContainText("denied by the operator");
  await expect(page.locator(".log")).not.toContainText("minted");
});
