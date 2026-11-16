import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { senderAddress } from "../mail.js";
import type {
  Action,
  Classification,
  MessageRow,
  PastDecision,
  QuarantineItem,
  SenderHistory,
  Stats,
  View,
} from "../types.js";
import type { Store } from "./index.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pmg_id VARCHAR(60) NOT NULL,
    receiver VARCHAR(320) NOT NULL,
    envelope_sender VARCHAR(320) NOT NULL DEFAULT '',
    from_header VARCHAR(500) NOT NULL DEFAULT '',
    sender_addr VARCHAR(320) NOT NULL DEFAULT '',
    subject VARCHAR(1000) NOT NULL DEFAULT '',
    received_at DATETIME NOT NULL,
    spamlevel DECIMAL(6,2) NOT NULL DEFAULT 0,
    bytes INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('pending','released','deleted','gone') NOT NULL DEFAULT 'pending',
    verdict ENUM('spam','legitimate','unsure') NULL,
    confidence TINYINT UNSIGNED NULL,
    category VARCHAR(40) NULL,
    reason VARCHAR(500) NULL,
    block_advice ENUM('none','address','domain') NULL,
    block_reason VARCHAR(300) NULL,
    provider VARCHAR(20) NULL,
    model VARCHAR(80) NULL,
    classify_error VARCHAR(500) NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pmg_id (pmg_id),
    KEY ix_status (status, received_at),
    KEY ix_sender (sender_addr)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT UNSIGNED NOT NULL,
    action ENUM('release','delete') NOT NULL,
    actor VARCHAR(64) NOT NULL,
    ai_verdict ENUM('spam','legitimate','unsure') NULL,
    ai_confidence TINYINT UNSIGNED NULL,
    decided_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_decided (decided_at),
    CONSTRAINT fk_decision_message FOREIGN KEY (message_id) REFERENCES messages (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class MysqlStore implements Store {
  private readonly pool: Pool;

  constructor(opts: MysqlOptions) {
    this.pool = mysql.createPool({
      ...opts,
      charset: "utf8mb4",
      timezone: "Z",
      decimalNumbers: true,
      connectionLimit: 5,
    });
  }

  async init(): Promise<void> {
    await this.pool.query("SET time_zone = '+00:00'");
    for (const sql of SCHEMA) await this.pool.query(sql);
    // Columns added after the first release; older databases get them here.
    await this.addColumn("messages", "block_advice", "ENUM('none','address','domain') NULL AFTER reason");
    await this.addColumn("messages", "block_reason", "VARCHAR(300) NULL AFTER block_advice");
  }

  private async addColumn(table: string, column: string, definition: string): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    if (!rows.length) await this.pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertItems(items: QuarantineItem[]): Promise<void> {
    for (let i = 0; i < items.length; i += 200) {
      const rows = items
        .slice(i, i + 200)
        .map((it) => [
          it.id,
          it.receiver.slice(0, 320),
          it.envelope_sender.slice(0, 320),
          it.from.slice(0, 500),
          senderAddress(it.from).slice(0, 320),
          it.subject.slice(0, 1000),
          new Date(it.time * 1000),
          it.spamlevel,
          it.bytes,
        ]);
      await this.pool.query(
        `INSERT IGNORE INTO messages
           (pmg_id, receiver, envelope_sender, from_header, sender_addr, subject, received_at, spamlevel, bytes)
         VALUES ?`,
        [rows],
      );
    }
  }

  async unclassified(limit: number): Promise<MessageRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM messages
        WHERE status = 'pending' AND (verdict IS NULL OR block_advice IS NULL) AND attempts < 3
        ORDER BY received_at DESC LIMIT ?`,
      [limit],
    );
    return rows as MessageRow[];
  }

  async saveClassification(id: number, c: Classification): Promise<void> {
    await this.pool.query(
      `UPDATE messages
          SET verdict = ?, confidence = ?, category = ?, reason = ?, block_advice = ?, block_reason = ?,
              provider = ?, model = ?,
              classify_error = NULL, attempts = attempts + 1
        WHERE id = ?`,
      [c.verdict, c.confidence, c.category, c.reason, c.block_advice, c.block_reason, c.provider, c.model, id],
    );
  }

  async saveClassifyError(id: number, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE messages SET classify_error = ?, attempts = attempts + 1 WHERE id = ?",
      [error.slice(0, 500), id],
    );
  }

  async retryFailed(): Promise<void> {
    await this.pool.query("UPDATE messages SET attempts = 0 WHERE status = 'pending' AND verdict IS NULL");
  }

  async markGone(presentPmgIds: string[]): Promise<number> {
    const [res] = presentPmgIds.length
      ? await this.pool.query<ResultSetHeader>(
          "UPDATE messages SET status = 'gone' WHERE status = 'pending' AND pmg_id NOT IN (?)",
          [presentPmgIds],
        )
      : await this.pool.query<ResultSetHeader>("UPDATE messages SET status = 'gone' WHERE status = 'pending'");
    return res.affectedRows;
  }

  async list(view: View, spamHideConfidence: number): Promise<MessageRow[]> {
    const sql =
      view === "review"
        ? `SELECT * FROM messages
            WHERE status = 'pending' AND (verdict IS NULL OR verdict <> 'spam' OR confidence < ?)
            ORDER BY FIELD(COALESCE(verdict, 'unsure'), 'legitimate', 'unsure', 'spam'), received_at DESC
            LIMIT 1000`
        : view === "spam"
          ? `SELECT * FROM messages
              WHERE status = 'pending' AND verdict = 'spam' AND confidence >= ?
              ORDER BY received_at DESC LIMIT 1000`
          : `SELECT * FROM messages
              WHERE status IN ('released', 'deleted') AND ? IS NOT NULL
              ORDER BY updated_at DESC LIMIT 500`;
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [spamHideConfidence]);
    return rows as MessageRow[];
  }

  async getMany(ids: number[]): Promise<MessageRow[]> {
    if (!ids.length) return [];
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM messages WHERE id IN (?)", [ids]);
    return rows as MessageRow[];
  }

  async recordAction(ids: number[], action: Action, actor: string): Promise<void> {
    if (!ids.length) return;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO decisions (message_id, action, actor, ai_verdict, ai_confidence)
         SELECT id, ?, ?, verdict, confidence FROM messages WHERE id IN (?) AND status = 'pending'`,
        [action, actor.slice(0, 64), ids],
      );
      await conn.query("UPDATE messages SET status = ? WHERE id IN (?) AND status = 'pending'", [
        action === "release" ? "released" : "deleted",
        ids,
      ]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async recentDecisions(limit: number): Promise<PastDecision[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT m.from_header, m.subject, d.action, d.ai_verdict
         FROM decisions d JOIN messages m ON m.id = d.message_id
        ORDER BY (d.action = 'release') DESC, d.decided_at DESC LIMIT ?`,
      [limit],
    );
    return rows as PastDecision[];
  }

  async senderHistory(senderAddr: string): Promise<SenderHistory> {
    if (!senderAddr) return { released: 0, deleted: 0 };
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(status = 'released'), 0) AS released,
              COALESCE(SUM(status = 'deleted'), 0) AS deleted
         FROM messages WHERE sender_addr = ?`,
      [senderAddr],
    );
    return { released: Number(rows[0]?.released ?? 0), deleted: Number(rows[0]?.deleted ?? 0) };
  }

  async counts(spamHideConfidence: number): Promise<Record<View, number>> {
    const [[c]] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(status = 'pending' AND verdict = 'spam' AND confidence >= ?), 0) AS spam,
              COALESCE(SUM(status = 'pending'), 0) AS pending,
              COALESCE(SUM(status IN ('released', 'deleted')), 0) AS history
         FROM messages`,
      [spamHideConfidence],
    );
    const spam = Number(c?.spam ?? 0);
    return { review: Number(c?.pending ?? 0) - spam, spam, history: Number(c?.history ?? 0) };
  }

  async stats(): Promise<Stats> {
    const [[p]] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'",
    );
    const [[d]] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS decisions,
              COALESCE(SUM((action = 'release' AND ai_verdict = 'legitimate')
                        OR (action = 'delete' AND ai_verdict = 'spam')), 0) AS agreed,
              COALESCE(SUM(action = 'release' AND ai_verdict = 'spam'), 0) AS missedLegitimate,
              COALESCE(SUM(action = 'delete' AND ai_verdict = 'legitimate'), 0) AS missedSpam
         FROM decisions`,
    );
    return {
      pending: Number(p?.n ?? 0),
      decisions: Number(d?.decisions ?? 0),
      agreed: Number(d?.agreed ?? 0),
      missedLegitimate: Number(d?.missedLegitimate ?? 0),
      missedSpam: Number(d?.missedSpam ?? 0),
    };
  }
}
