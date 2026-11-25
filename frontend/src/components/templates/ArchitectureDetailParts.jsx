import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { Download, ExternalLink, Code, FlaskConical, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { architectureSummary } from './architectureModel';

// The head tags, landing-pane buttons and related list of
// ArchitectureDetailTemplate.

export function ArchitectureHelmet({ architecture, canonicalUrl }) {
  const summary = architectureSummary(architecture);
  return (
    <Helmet>
      <title>{`${architecture.title} | HCW`}</title>
      <meta name="description" content={summary} />
      <link rel="canonical" href={canonicalUrl} />
      {/* Open Graph */}
      <meta property="og:type" content="article" />
      <meta property="og:title" content={`${architecture.title} | HCW`} />
      <meta property="og:description" content={summary} />
      <meta property="og:url" content={canonicalUrl} />
      {architecture.diagramUrl && <meta property="og:image" content={architecture.diagramUrl} />}
      {/* Twitter Card */}
      <meta
        name="twitter:card"
        content={architecture.diagramUrl ? 'summary_large_image' : 'summary'}
      />
      <meta name="twitter:title" content={`${architecture.title} | HCW`} />
      <meta name="twitter:description" content={summary} />
      {architecture.diagramUrl && <meta name="twitter:image" content={architecture.diagramUrl} />}
    </Helmet>
  );
}

// One outline button that links inside the site.
function LinkButton({ to, Icon, label }) {
  return (
    <Button variant="outline" asChild>
      <Link to={to}>
        <Icon className="h-4 w-4 mr-2" />
        {label}
      </Link>
    </Button>
  );
}

export function LandingActions({ architecture, hasImplementation, onViewCode }) {
  return (
    <>
      {architecture.diagramUrl && (
        <Button asChild>
          <a href={architecture.diagramUrl} download>
            <Download className="h-4 w-4 mr-2" />
            Download Diagram
          </a>
        </Button>
      )}
      {hasImplementation && (
        <Button variant="outline" onClick={onViewCode}>
          <Code className="h-4 w-4 mr-2" />
          View IaC Code
        </Button>
      )}
      {architecture.landingZonePreset && (
        <LinkButton
          to={`/tools/landing-zone?preset=${architecture.landingZonePreset}`}
          Icon={Layers}
          label="Landing Zone Builder"
        />
      )}
      {architecture.interactiveLabId && (
        <LinkButton
          to={`/education/labs/${architecture.interactiveLabId}`}
          Icon={FlaskConical}
          label="Test in Browser Lab"
        />
      )}
      {architecture.demoUrl && (
        <Button variant="outline" asChild>
          <a href={architecture.demoUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4 mr-2" />
            Live Demo
          </a>
        </Button>
      )}
    </>
  );
}

export function RelatedArchitectures({ related }) {
  if (!related || related.length === 0) return null;
  return (
    <section>
      <h2 className="text-2xl font-bold mb-6">Related Architectures</h2>
      <div className="grid md:grid-cols-3 gap-4">
        {related.map((entry, i) => (
          <Card key={i} className="bg-card/40 hover:bg-card/60 transition-all">
            <CardContent className="p-4">
              <h3 className="font-semibold mb-2">{entry.title}</h3>
              <p className="text-sm text-muted-foreground line-clamp-2">{entry.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
