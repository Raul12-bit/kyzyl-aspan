import { AI_SYSTEMS, type AiId } from '@/domain/ai/registry';
import { useHeliosAvailable } from '@/features/helios/api';
import { ModelsSection } from '@/features/mission/HeliosSections';
import { useI18n } from '@/i18n';
import { SystemDiagram } from './SystemDiagram';

/** Tab "System": the architecture, one fire end to end, and who does what (from the registry). */
export function SystemTab({ onSelect }: { onSelect: (id: AiId) => void }) {
  const { m } = useI18n();
  const t = m.ai.lab.system;
  const helios = useHeliosAvailable();
  return (
    <div className="grid gap-14">
      <figure className="lab-diagram m-0">
        <SystemDiagram onSelect={onSelect} />
      </figure>

      <section aria-labelledby="lab-flow">
        <h2 id="lab-flow" className="lab-h2">
          {t.flowTitle}
        </h2>
        <ol className="lab-flow">
          {t.flow.map((step) => (
            <li key={step.title}>
              <span className="lab-flow__t">{step.t}</span>
              <b>{step.title}</b>
              <span>{step.body}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="lab-table">
        <h2 id="lab-table" className="lab-h2">
          {t.tableTitle}
        </h2>
        <div className="lab-tablewrap">
          <table className="lab-table">
            <thead>
              <tr>
                <th scope="col">{t.cols.ai}</th>
                <th scope="col">{t.cols.where}</th>
                <th scope="col">{t.cols.input}</th>
                <th scope="col">{t.cols.output}</th>
                <th scope="col">{t.cols.code}</th>
                <th scope="col">{t.cols.real}</th>
              </tr>
            </thead>
            <tbody>
              {AI_SYSTEMS.map((a) => (
                <tr key={a.id}>
                  <th scope="row">
                    <button type="button" className="lab-linkbtn" onClick={() => onSelect(a.id)}>
                      {m.ai.systems[a.id].name} · {m.ai.systems[a.id].role}
                    </button>
                  </th>
                  <td>{m.ai.systems[a.id].where}</td>
                  <td>{t.rows[a.id].input}</td>
                  <td>{t.rows[a.id].output}</td>
                  <td>
                    <code className="lab-code">
                      {a.modules.map((p) => p.replace('src/domain/', '')).join(' · ')}
                    </code>
                    {a.endpoint ? <code className="lab-code mt-1 block">POST {a.endpoint}</code> : null}
                  </td>
                  <td>
                    <code className="lab-code">{a.helios.join(' · ')}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {helios ? (
        <ModelsSection />
      ) : (
        <section aria-labelledby="lab-real" className="lab-note">
          <h2 id="lab-real" className="lab-h2 !mb-2">
            {t.realTitle}
          </h2>
          <p className="m-0 max-w-[70ch] text-[14.5px] leading-relaxed text-ink-muted">{t.realOffline}</p>
        </section>
      )}
    </div>
  );
}
