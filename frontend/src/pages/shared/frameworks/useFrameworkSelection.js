/**
 * Which framework is shown and which one or two of its concepts are picked,
 * and the architecture recommendation those picks lead to. Moved out of
 * FrameworksPage.jsx when that component grew too long to follow.
 */
import { useMemo, useState } from 'react';

function conceptRecommendation(concept) {
  if (!concept) return '';
  if (concept.recommendation) return concept.recommendation;
  if (concept.details) return concept.details;
  return concept.summary;
}

/** The chosen framework when it is still in the list, else the first one, else ''. */
function resolveFrameworkId(frameworks, activeFrameworkId) {
  if (!frameworks.length) return '';
  if (activeFrameworkId && frameworks.some((framework) => framework.id === activeFrameworkId)) {
    return activeFrameworkId;
  }
  return frameworks[0].id;
}

/** The picked concepts still in the framework (the last two), else its first concept. */
function resolveConceptIds(activeFramework, selectedConceptIds) {
  if (!activeFramework) return [];
  const conceptIds = new Set(activeFramework.concepts.map((concept) => concept.id));
  const filtered = selectedConceptIds.filter((id) => conceptIds.has(id));
  if (filtered.length > 0) return filtered.slice(-2);
  return activeFramework.concepts[0] ? [activeFramework.concepts[0].id] : [];
}

/** The picked concepts' recommendations together, or the framework's own. */
function recommendationFor(activeFramework, selectedConcepts) {
  if (!activeFramework) return '';
  const recommendations = selectedConcepts
    .map((concept) => conceptRecommendation(concept))
    .filter(Boolean);
  return recommendations.length > 0
    ? recommendations.join(' ')
    : activeFramework.architectureRecommendation;
}

export function useFrameworkSelection(frameworks) {
  const [activeFrameworkId, setActiveFrameworkId] = useState('');
  const [selectedConceptIds, setSelectedConceptIds] = useState([]);

  const resolvedActiveFrameworkId = useMemo(
    () => resolveFrameworkId(frameworks, activeFrameworkId),
    [activeFrameworkId, frameworks]
  );

  const activeFramework = useMemo(
    () =>
      frameworks.find((framework) => framework.id === resolvedActiveFrameworkId) ||
      frameworks[0] ||
      null,
    [frameworks, resolvedActiveFrameworkId]
  );

  const resolvedSelectedConceptIds = useMemo(
    () => resolveConceptIds(activeFramework, selectedConceptIds),
    [activeFramework, selectedConceptIds]
  );

  const selectedConcepts = useMemo(() => {
    if (!activeFramework) return [];
    const selectedSet = new Set(resolvedSelectedConceptIds);
    return activeFramework.concepts.filter((concept) => selectedSet.has(concept.id));
  }, [activeFramework, resolvedSelectedConceptIds]);

  const toggleConcept = (conceptId) => {
    setSelectedConceptIds((current) => {
      if (current.includes(conceptId)) {
        return current.filter((id) => id !== conceptId);
      }
      return [...current, conceptId].slice(-2);
    });
  };

  const architectureRecommendation = useMemo(
    () => recommendationFor(activeFramework, selectedConcepts),
    [activeFramework, selectedConcepts]
  );

  return {
    activeFramework,
    setActiveFrameworkId,
    selectedConceptIds,
    selectedConcepts,
    toggleConcept,
    architectureRecommendation,
  };
}
