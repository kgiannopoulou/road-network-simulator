import { activation } from './activations.js';

/**
 * Week 13: a feed-forward neural network written from scratch.
 *
 *   Sensors → Inputs → Hidden layer(s) → Outputs → Throttle / Brake / Steering
 *
 * A Layer is a set of neurons that all see every value of the previous
 * layer. Neuron j computes
 *
 *     output[j] = activation( Σ_i inputs[i] · weights[j][i]  +  biases[j] )
 *
 * There is no training by gradient descent here: the weights are found by
 * evolution (genetics.js), so all a network needs is feedForward(), a way to
 * copy itself and a way to be saved.
 */
export class Layer {
  constructor(inputCount, outputCount, activationName = 'tanh') {
    this.inputCount = inputCount;
    this.outputCount = outputCount;
    this.activation = activationName;
    this.weights = Array.from({ length: outputCount }, () => new Array(inputCount).fill(0));
    this.biases = new Array(outputCount).fill(0);
    // Last values seen, kept for the network visualiser.
    this.inputs = new Array(inputCount).fill(0);
    this.outputs = new Array(outputCount).fill(0);
  }

  /** Fill weights and biases with uniform values in [−1, 1]. */
  randomize(rng = Math.random) {
    for (const row of this.weights) for (let i = 0; i < row.length; i++) row[i] = rng() * 2 - 1;
    for (let j = 0; j < this.biases.length; j++) this.biases[j] = rng() * 2 - 1;
    return this;
  }

  feedForward(inputs) {
    if (inputs.length !== this.inputCount) {
      throw new Error(`Layer expects ${this.inputCount} inputs, got ${inputs.length}`);
    }
    const f = activation(this.activation);
    for (let i = 0; i < inputs.length; i++) this.inputs[i] = inputs[i];
    for (let j = 0; j < this.outputCount; j++) {
      const w = this.weights[j];
      let sum = this.biases[j];
      for (let i = 0; i < inputs.length; i++) sum += inputs[i] * w[i];
      this.outputs[j] = f(sum);
    }
    return this.outputs.slice();
  }

  /** Neuron j as a plain object (handy for inspection and the visualiser). */
  neuron(j) {
    return { weights: this.weights[j], bias: this.biases[j], output: this.outputs[j] };
  }
}

export class NeuralNetwork {
  /**
   * @param {number[]} sizes  neurons per layer, inputs first: [8, 6, 3]
   * @param {object} options  { hidden: 'tanh', output: 'tanh', rng }
   */
  constructor(sizes, { hidden = 'tanh', output = 'tanh', rng = null } = {}) {
    if (sizes.length < 2) throw new Error('A network needs at least an input and an output layer');
    this.sizes = [...sizes];
    this.layers = [];
    for (let k = 0; k < sizes.length - 1; k++) {
      const isOutput = k === sizes.length - 2;
      this.layers.push(new Layer(sizes[k], sizes[k + 1], isOutput ? output : hidden));
    }
    if (rng) this.randomize(rng);
  }

  get inputCount() {
    return this.sizes[0];
  }

  get outputCount() {
    return this.sizes[this.sizes.length - 1];
  }

  randomize(rng = Math.random) {
    for (const layer of this.layers) layer.randomize(rng);
    return this;
  }

  feedForward(inputs) {
    let values = inputs;
    for (const layer of this.layers) values = layer.feedForward(values);
    return values;
  }

  /** Every weight and bias as one flat array (the genome), and back. */
  toGenome() {
    const genes = [];
    for (const layer of this.layers) {
      for (const row of layer.weights) genes.push(...row);
      genes.push(...layer.biases);
    }
    return genes;
  }

  setGenome(genes) {
    let k = 0;
    for (const layer of this.layers) {
      for (const row of layer.weights) for (let i = 0; i < row.length; i++) row[i] = genes[k++];
      for (let j = 0; j < layer.biases.length; j++) layer.biases[j] = genes[k++];
    }
    if (k !== genes.length) throw new Error(`Genome has ${genes.length} genes, network needs ${k}`);
    return this;
  }

  get geneCount() {
    return this.layers.reduce((n, l) => n + l.outputCount * (l.inputCount + 1), 0);
  }

  clone() {
    return NeuralNetwork.fromJSON(this.toJSON());
  }

  toJSON() {
    return {
      sizes: this.sizes,
      layers: this.layers.map((l) => ({
        activation: l.activation,
        weights: l.weights.map((row) => row.slice()),
        biases: l.biases.slice(),
      })),
    };
  }

  static fromJSON(data) {
    const network = new NeuralNetwork(data.sizes);
    data.layers.forEach((saved, k) => {
      const layer = network.layers[k];
      layer.activation = saved.activation;
      layer.weights = saved.weights.map((row) => row.slice());
      layer.biases = saved.biases.slice();
    });
    return network;
  }
}
