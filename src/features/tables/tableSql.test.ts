import { describe, expect, it } from "vitest";
import type { QueryColumn } from "../../bindings/QueryColumn";
import {
  buildDdlStatements,
  buildDmlStatements,
  type TableColumnDefinition,
} from "./tableSql";

const ID_COLUMN: TableColumnDefinition = {
  sourceName: "id",
  name: "id",
  type: "int",
  nullable: false,
  defaultValue: null,
  comment: "",
  primary: true,
  extra: "auto_increment",
};

/**
 * Verifies visual structure changes produce escaped native MySQL DDL.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertDdlGeneration(): void {
  const renamed = { ...ID_COLUMN, name: "order_id", comment: "主键" };
  const added: TableColumnDefinition = {
    sourceName: null,
    name: "status",
    type: "varchar(20)",
    nullable: false,
    defaultValue: "new",
    comment: "",
    primary: false,
    extra: "",
  };

  expect(buildDdlStatements("shop", "orders", [ID_COLUMN], [renamed, added])).toEqual([
    "ALTER TABLE `shop`.`orders` CHANGE COLUMN `id` `order_id` int NOT NULL auto_increment COMMENT '主键';",
    "ALTER TABLE `shop`.`orders` ADD COLUMN `status` varchar(20) NOT NULL DEFAULT 'new';",
  ]);
}

/**
 * Verifies staged row changes use original primary keys inside one safe change set.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertDmlGeneration(): void {
  const nameColumn: TableColumnDefinition = {
    ...ID_COLUMN,
    sourceName: "name",
    name: "name",
    type: "varchar(50)",
    primary: false,
    extra: "",
  };
  const queryColumns: QueryColumn[] = [
    { name: "id", databaseType: "INT", nullable: false },
    { name: "name", databaseType: "VARCHAR", nullable: true },
  ];
  const updates = new Map([[0, new Map([["name", "O'Reilly"]])]]);
  const inserts = [new Map<string, string | null>([["id", "2"], ["name", null]])];

  expect(
    buildDmlStatements({
      database: "shop",
      table: "orders",
      queryColumns,
      rows: [[{ kind: "integer", value: "1" }, { kind: "text", value: "old" }]],
      schema: [ID_COLUMN, nameColumn],
      updatedRows: updates,
      deletedRows: new Set(),
      insertedRows: inserts,
    }),
  ).toEqual([
    "UPDATE `shop`.`orders` SET `name` = 'O''Reilly' WHERE `id` = 1;",
    "INSERT INTO `shop`.`orders` (`id`, `name`) VALUES (2, NULL);",
  ]);
}

describe("table SQL generation", () => {
  it("generates native DDL from the structure draft", assertDdlGeneration);
  it("generates primary-key-scoped DML from the change set", assertDmlGeneration);
});
