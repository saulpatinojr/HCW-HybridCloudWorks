import { useCallback, useEffect, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
export function useForceGraph(graph, animate, width, height) {
  const engine = useRef(null);
  const previous = useRef(new Map());
  const [positions, setPositions] = useState([]);
  useEffect(() => {
    let alive = true;
    const nodes = graph.nodes.map((n) => {
      const old = previous.current.get(n.id);
      return old
        ? { ...n, x: (old.x * width) / old.width, y: (old.y * height) / old.height }
        : { ...n };
    });
    const links = graph.links.map((e) => ({ ...e, source: e.from, target: e.to }));
    const publish = () => {
      if (alive) {
        previous.current = new Map(nodes.map(({ id, x, y }) => [id, { x, y, width, height }]));
        setPositions(nodes.map((n) => ({ ...n })));
      }
    };
    const simulation = forceSimulation(nodes)
      .force(
        'links',
        forceLink(links)
          .id((n) => n.id)
          .distance((e) => (e.kind === 'suggested' ? 190 : 115))
          .strength((e) => (e.kind === 'suggested' ? 0.035 : 0.3))
      )
      .force(
        'charge',
        forceManyBody()
          .strength(-230 * Math.min(width / 700, 1.5))
          .distanceMax(650)
      )
      .force('collide', forceCollide(27).iterations(2))
      .force('x', forceX(width / 2).strength(0.075))
      .force('y', forceY(height / 2).strength(0.085))
      .on('tick', publish)
      .stop();
    simulation.tick(animate ? 65 : 240);
    engine.current = { simulation, nodes, publish };
    Promise.resolve().then(publish);
    if (animate) simulation.alpha(0.55).restart();
    return () => {
      alive = false;
      simulation.stop();
      engine.current = null;
    };
  }, [graph, animate, width, height]);
  const drag = useCallback(
    (id, point, release = false) => {
      const { current } = engine;
      const node = current?.nodes.find((n) => n.id === id);
      if (!node) return;
      node.fx = release ? null : point.x;
      node.fy = release ? null : point.y;
      if (!release) {
        node.x = point.x;
        node.y = point.y;
      }
      current.publish();
      if (animate) current.simulation.alpha(0.3).restart();
    },
    [animate]
  );
  return { positions, drag };
}
