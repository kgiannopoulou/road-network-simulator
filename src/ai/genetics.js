import { gaussian } from '../sensors/noise.js';

/**
 * Week 16: the genetic algorithm. Networks are treated as genomes (flat
 * arrays of weights and biases, see NeuralNetwork.toGenome()).
 *
 *   fitness        how well a driver did (computed by the trainer)
 *   elitism        the best few are copied unchanged into the next generation
 *   selection      tournament: pick k at random, the fittest one wins
 *   crossover      a child takes each gene from one of its two parents
 *   mutation       each gene, with probability `rate`, gets Gaussian noise
 *   regeneration   elites + children form the new population
 */

export const GA_DEFAULTS = {
  elitism: 2, // drivers copied unchanged
  tournamentSize: 4,
  crossoverRate: 0.7, // otherwise the child is a copy of one parent
  mutationRate: 0.1, // probability per gene
  mutationAmount: 0.3, // standard deviation of the noise added
};

/** Add Gaussian noise to a fraction of the genes (in place on a copy). */
export function mutate(genome, { rate, amount }, rng) {
  return genome.map((g) => (rng() < rate ? g + gaussian(rng) * amount : g));
}

/** Uniform crossover: every gene comes from parent a or b with equal chance. */
export function crossover(a, b, rng) {
  if (a.length !== b.length) throw new Error('Parents have different genome sizes');
  return a.map((gene, i) => (rng() < 0.5 ? gene : b[i]));
}

/** Tournament selection over [{ genome, fitness }]: best of k random picks. */
export function tournament(population, k, rng) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const candidate = population[Math.floor(rng() * population.length)];
    if (!best || candidate.fitness > best.fitness) best = candidate;
  }
  return best;
}

/**
 * Next generation of genomes from a scored population.
 * The first `elitism` entries of the result are the elites, best first.
 */
export function nextGeneration(scored, size, options, rng) {
  const o = { ...GA_DEFAULTS, ...options };
  const ranked = [...scored].sort((a, b) => b.fitness - a.fitness);
  const next = ranked.slice(0, Math.min(o.elitism, size)).map((s) => s.genome.slice());
  while (next.length < size) {
    const a = tournament(ranked, o.tournamentSize, rng);
    let child;
    if (rng() < o.crossoverRate) {
      const b = tournament(ranked, o.tournamentSize, rng);
      child = crossover(a.genome, b.genome, rng);
    } else {
      child = a.genome.slice();
    }
    next.push(mutate(child, { rate: o.mutationRate, amount: o.mutationAmount }, rng));
  }
  return next;
}
