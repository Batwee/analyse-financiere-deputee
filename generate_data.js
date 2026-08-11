const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const OUTPUT_FILE = 'hatvp_data.json';

function downloadXML(url) {
  return new Promise((resolve, reject) => {
    console.log('Téléchargement du fichier XML HATVP...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

function extractItems(node) {
  let list = [];
  if (!node) return list;
  if (Array.isArray(node)) {
    for (const item of node) list.push(...extractItems(item));
  } else if (typeof node === 'object') {
    if (node.nomSociete) {
      list.push(node);
    } else {
      for (const key of Object.keys(node)) {
        list.push(...extractItems(node[key]));
      }
    }
  }
  return list;
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === 'declaration' || name === 'items'
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];
    
    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    console.log(`Déclarations trouvées dans le XML : ${declarations.length}`);

    const records = [];

    for (const decla of declarations) {
      const typeMandat = String(decla?.qualiteMandat?.typeMandat || '').toLowerCase();
      const titre = String(decla?.qualiteMandat?.qualiteDeclarantForAffichage || '').toLowerCase();

      // Détection souple des députés (ex: "député", "depute", "députée")
      const isDepute = typeMandat.includes('deput') || titre.includes('deput') || titre.includes('déput');
      if (!isDepute) continue;

      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(decla?.qualiteMandat?.labelOrgane || 'Non renseigné').trim();
      }

      const partSection = decla?.participationsFinancieresDto;
      if (!partSection) continue;

      const items = extractItems(partSection);

      for (const item of items) {
        const nomSociete = String(item?.nomSociete || '').trim().toUpperCase();
        const evaluationRaw = String(item?.evaluation || '0').trim();

        if (!nomSociete) continue;

        const cleanVal = evaluationRaw.replace(/\s+/g, '');
        const matches = cleanVal.match(/\d+/);
        const montant = matches ? parseFloat(matches[0]) : 0;

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Participations de députés extraites : ${records.length}`);

    if (records.length === 0) {
      throw new Error("L'extraction a renvoyé 0 résultat. Le fichier JSON n'a pas été écrasé pour éviter de commiter une liste vide.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} mis à jour avec succès avec ${records.length} entrées.`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
