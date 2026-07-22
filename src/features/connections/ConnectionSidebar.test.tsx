import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { ConnectionSidebar } from "./ConnectionSidebar";

const MYSQL_CONNECTIONS: ConnectionProfile[] = [
  {
    id: "0d27c056-fd60-4ed4-9570-ab63c500073c",
    name: "订单主库",
    engine: "my_sql",
    environment: "production",
    host: "mysql.internal",
    port: 3306,
    username: "pipa",
    database: "orders",
    tlsMode: "required",
  },
  {
    id: "c5b9bdc0-b6c6-4a38-8e05-f2857ca2659f",
    name: "本地开发",
    engine: "my_sql",
    environment: "development",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    database: null,
    tlsMode: "disabled",
  },
];

/**
 * Verifies strict engine grouping, empty states, and the selected-row interaction.
 * Parameters: none.
 * @returns A promise that resolves after the selection state is asserted.
 * Side effects: renders the sidebar and dispatches one click event.
 */
async function assertGroupedConnectionSelection(): Promise<void> {
  const selectConnection = vi.fn();
  const { rerender } = render(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={null}
      onSelectConnection={selectConnection}
      onAddConnection={vi.fn()}
    />,
  );

  const mysqlGroup = screen.getByRole("region", { name: "MySQL 连接" });
  const postgresqlGroup = screen.getByRole("region", { name: "PostgreSQL 连接" });
  const mongodbGroup = screen.getByRole("region", { name: "MongoDB 连接" });
  const redisGroup = screen.getByRole("region", { name: "Redis 连接" });

  expect(within(mysqlGroup).getByRole("heading", { name: "MySQL" })).toBeVisible();
  expect(within(postgresqlGroup).getByRole("heading", { name: "PostgreSQL" })).toBeVisible();
  expect(within(mongodbGroup).getByRole("heading", { name: "MongoDB" })).toBeVisible();
  expect(within(redisGroup).getByRole("heading", { name: "Redis" })).toBeVisible();
  expect(within(mysqlGroup).getByRole("button", { name: /订单主库/ })).toHaveStyle({
    minHeight: "40px",
  });
  expect(within(mysqlGroup).getByRole("button", { name: /本地开发/ })).toBeVisible();
  expect(within(postgresqlGroup).queryByText("订单主库")).not.toBeInTheDocument();
  expect(within(mongodbGroup).getByText("暂无连接")).toBeVisible();
  expect(within(redisGroup).getByText("暂无连接")).toBeVisible();

  fireEvent.click(within(mysqlGroup).getByRole("button", { name: /订单主库/ }));
  expect(selectConnection).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id);

  rerender(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onSelectConnection={selectConnection}
      onAddConnection={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: /订单主库/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("button", { name: /订单主库/ })).toHaveClass("is-selected");
}

/**
 * Registers the connection-sidebar behavior tests.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: registers one Vitest case.
 */
function registerConnectionSidebarTests(): void {
  it("keeps engines separate and exposes a strong selected state", assertGroupedConnectionSelection);
}

describe("ConnectionSidebar", registerConnectionSidebarTests);
