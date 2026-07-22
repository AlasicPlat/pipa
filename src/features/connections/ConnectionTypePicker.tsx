import { ArrowLeft, Database, Server, Zap } from "lucide-react";
import type { Engine } from "../../bindings/Engine";

interface ConnectionTypePickerProps {
  onCancel: () => void;
  onSelect: (engine: Extract<Engine, "my_sql" | "redis">) => void;
}

/**
 * Presents the globally supported database types before opening an engine form.
 * @param props - Engine selection and cancellation actions.
 * @returns The database-type picker.
 * Side effects: invokes callbacks only after explicit button interaction.
 */
export function ConnectionTypePicker({ onCancel, onSelect }: ConnectionTypePickerProps) {
  return (
    <section className="connection-type-picker" aria-labelledby="connection-type-title">
      <header>
        <span className="connection-form-card__icon" aria-hidden="true"><Server size={18} /></span>
        <span>
          <span className="eyebrow">NEW CONNECTION</span>
          <h2 id="connection-type-title">选择数据库类型</h2>
          <p>连接配置和凭据均只保存在本机。</p>
        </span>
      </header>
      <div className="connection-type-grid">
        <button onClick={() => onSelect("my_sql")} type="button">
          <span className="connection-type-grid__icon connection-type-grid__icon--mysql"><Database size={20} /></span>
          <strong>MySQL</strong>
          <small>SQL 查询、数据编辑、表结构与索引</small>
          <b>可用</b>
        </button>
        <button onClick={() => onSelect("redis")} type="button">
          <span className="connection-type-grid__icon connection-type-grid__icon--redis"><Zap size={20} /></span>
          <strong>Redis</strong>
          <small>连接测试与本地凭据保存</small>
          <b>可用</b>
        </button>
        <button disabled type="button">
          <span className="connection-type-grid__icon"><Database size={20} /></span>
          <strong>PostgreSQL</strong>
          <small>关系型数据库工作台</small>
          <b>即将支持</b>
        </button>
        <button disabled type="button">
          <span className="connection-type-grid__icon"><Database size={20} /></span>
          <strong>MongoDB</strong>
          <small>文档数据库工作台</small>
          <b>即将支持</b>
        </button>
      </div>
      <footer>
        <button className="button button--secondary" onClick={onCancel} type="button"><ArrowLeft size={14} />取消</button>
      </footer>
    </section>
  );
}
