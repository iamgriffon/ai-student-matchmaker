import tf from "@tensorflow/tfjs";

async function trainModel(inputXs: tf.Tensor, outputYs: tf.Tensor) {
  const model = tf.sequential();

  // Primeira camada da rede
  // Entrada de 7 posições (3 cores, idade normalizada e 3 cidades)
  // 80 neuronios = pouca base de treino -> mais complexidade a rede vai arender -> mais computing power a maquina vai usar
  // a ReLU age como filtro, somente os dados "interessantes" ficam na rede, valores negativos são ignorados/descartados
  // a primeira camada tem 80 neuronios, a segunda camada tem 3 (uma para cada categoria)
  model.add(
    tf.layers.dense({ units: 80, inputShape: [7], activation: "relu" }),
  );

  // OUTPUT: 3 neuronios => 3 camadas (1 para cada categoria - premium/medium/basic)
  // a softmax normaliza as probabilidades, garantindo que a soma de todas as probabilidades seja 1
  model.add(tf.layers.dense({ units: 3, activation: "softmax" }));

  // ADAM = Adaptive Moment Estimation
  // É um treinador pessoal moderno para redes neurais -> ajusta os pesos da rede de forma eficiente e inteligente que aprende com erros e acertos
  // categoricalCrossentropy -> ele compara com o que o modelo "acha" dos scores de cada categoria com a resposta certa
  // EXEMPLO: Categoria premium é sempre (1, 0, 0), medium é (0, 1, 0) e basic é (0, 0, 1)
  // quanto maior a disdtancia da previsão do modelo em relação a resposta correta = maior é o erro
  //
  // EXEMPLO: classificação de imagens, categorização de usuários... quaquer coisa em que a resposta só pode ser UMA COISA entre várias opções possiveis
  model.compile({
    optimizer: "adam",
    loss: "categoricalCrossentropy",
    metrics: ["accuracy"],
  });

  // TREINAMENTO DO modelo
  await model.fit(inputXs, outputYs, {
    verbose: 0, //sem logs internos, só logs externos
    epochs: 100, // vai passar por 100 épocas (iterações)
    shuffle: true, // vai randomizar os dados de treino em cada iteração para evitar bias
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        console.log(`Epoch ${epoch}: loss = ${logs?.loss}`);
      },
    },
  });
  return model;
}

async function predict(model: tf.Sequential, pessoaNormalizada: number[][]) {
  //transforna o array de entrada em um tensor 2D
  const tfInput = tf.tensor2d(pessoaNormalizada);
  // executa a previsão usando o modelo
  const prediction = model.predict(tfInput) as tf.Tensor2D;
  const predArray = prediction.arraySync();
  return predArray[0]?.map((prob, index) => ({ prob, index }));
}

// Exemplo de pessoas para treino (cada pessoa com idade, cor e localização)
// const pessoas = [
//     { nome: "Erick", idade: 30, cor: "azul", localizacao: "São Paulo" },
//     { nome: "Ana", idade: 25, cor: "vermelho", localizacao: "Rio" },
//     { nome: "Carlos", idade: 40, cor: "verde", localizacao: "Curitiba" }
// ];

// Vetores de entrada com valores já normalizados e one-hot encoded
// Ordem: [idade_normalizada, azul, vermelho, verde, São Paulo, Rio, Curitiba]
// const tensorPessoas = [
//     [0.33, 1, 0, 0, 1, 0, 0], // Erick
//     [0, 0, 1, 0, 0, 1, 0],    // Ana
//     [1, 0, 0, 1, 0, 0, 1]     // Carlos
// ]

// Usamos apenas os dados numéricos, como a rede neural só entende números.
// tensorPessoasNormalizado corresponde ao dataset de entrada do modelo.
const tensorPessoasNormalizado = [
  [0.33, 1, 0, 0, 1, 0, 0], // Erick
  [0, 0, 1, 0, 0, 1, 0], // Ana
  [1, 0, 0, 1, 0, 0, 1], // Carlos
];

// Labels das categorias a serem previstas (one-hot encoded)
// [premium, medium, basic]
const tensorLabels = [
  [1, 0, 0], // premium - Erick
  [0, 1, 0], // medium - Ana
  [0, 0, 1], // basic - Carlos
];

const tensorLabelsNames = ["premium", "medium", "basic"];
const pessoa = {
  nome: "Gustavo",
  idade: 29,
  cor: "azul",
  localizacao: "São Paulo",
};

// normalizando agora
// idade_min = 25, idade_max = 40, então (29 - 25) / (40 - 25) = 0.266
const pessoaNormalizada = [
  [
    0.26, // idade_normalizada
    1, // azul
    0, // vermelho
    0, // verde
    1, // São Paulo
    0, // Rio
    0, // Curitiba
  ],
];

// Criamos tensores de entrada (xs) e saída (ys) para treinar o modelo
const inputXs = tf.tensor2d(tensorPessoasNormalizado);
const outputYs = tf.tensor2d(tensorLabels);

// inputXs.print();
// outputYs.print();

// quanto mais dados = melhor
// o algoritmo consegue entender melhor os padrões complexos do dataset
const model = await trainModel(inputXs, outputYs);

// Fazendo uma previsão com a pessoa normalizada
const pred = await predict(model, pessoaNormalizada);
const results = pred
  ?.sort((a, b) => b.prob - a.prob)
  .map((p) => `${tensorLabelsNames[p.index]} (${(p.prob * 100).toFixed(2)}%)`)
  .join("\n");

console.log(results);
