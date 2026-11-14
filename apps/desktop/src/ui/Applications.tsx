// Shows application availability without pretending to connect unfinished services.
import { TOOLS } from './constants';
import { ServiceLogo } from './ServiceLogo';
import { Badge, PagePanel } from './UI';

export function Applications() {
  return (
    <PagePanel>
      <p className="ui-help-text">Web services · coming soon</p>
      <div className="applications-grid" aria-label="Web applications">
        {TOOLS.map((tool) => (
          <article className="application-card" key={tool.id}>
            <div className="application-card-heading">
              <span className="ui-avatar">
                <ServiceLogo service={tool.id} />
              </span>
              <div>
                <strong>{tool.name}</strong>
                <p>{tool.capability}</p>
              </div>
            </div>
            <p>{tool.description}</p>
            <Badge>Not available yet</Badge>
          </article>
        ))}
      </div>
    </PagePanel>
  );
}
