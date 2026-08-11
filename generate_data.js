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

// Extraction robuste du montant/évaluation en évitant de lire une année
function parseEvaluationMontant(item) {
  // En priorité la valeur d'évaluation des parts/actions (champ 'evaluation')
  let rawVal = item.evaluation;

  if (rawVal === undefined || rawVal === null || rawVal === '') {
    rawVal = item.montant || item.valeur || '0';
  }

  // Si 'evaluation' ou 'montant' est un objet complexe
  if (typeof rawVal === 'object') {
    if (rawVal.evaluation) rawVal = rawVal.evaluation;
    else if (rawVal.montant) rawVal = rawVal.montant;
    else rawVal = JSON.stringify(rawVal);
  }

  const valStr = String(rawVal).trim();
  // Suppression des espaces insecables et normaux
  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

// Filtre député souple et fiable
function isDepute(decla) {
  const jsonStr = JSON.stringify(decla).toLowerCase();
  return (
    jsonStr.includes('dép') ||
    jsonStr.includes('depu') ||
    jsonStr.includes('assemblée nationale') ||
    jsonStr.includes('assemblee nationale')
  );
}

// Extrait récursivement les éléments ayant un nomSociete
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

// Extrait le nom complet depuis le nœud declarant
function getEluNom(decla) {
  const declarant = decla?.declarant || {};
  const prenom = String(declarant.prenom || declarant.prenomDeclarant || '').trim();
  const nom = String(declarant.nom || declarant.nomDeclarant || '').trim();
  
  if (prenom || nom) {
    return `${prenom} ${nom}`.trim();
  }

  // Fallback si la structure declarant est différente
  const generalNom = String(decla?.general?.declarant?.nom || '').trim();
  const generalPrenom = String(decla?.general?.declarant?.prenom || '').trim();
  if (generalNom || generalPrenom) {
    return `${generalPrenom} ${generalNom}`.trim();
  }

  return 'Inconnu';
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseNodeValue: false,
      isArray: (name) => ['declaration', 'items'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];

    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    console.log(`Nombre total de déclarations : ${declarations.length}`);

    const records = [];
    let countDeputes = 0;

    for (const decla of declarations) {
      if (!isDepute(decla)) continue;
      countDeputes++;

      const eluNom = getEluNom(decla);

      let parti = String(
        decla?.qualiteMandat?.organe?.codeOrgane ||
        decla?.qualiteMandat?.labelOrgane || 
        decla?.qualiteMandat?.organe?.label || 
        'Non renseigné'
      ).trim();

      // Isolation explicite de la section participations financieres
      const partSection = decla?.participationsFinancieresDto;
      if (!partSection || partSection.neant === 'true' || partSection.neant === true) {
        continue;
      }

      const itemsFound = extractItems(partSection);

      for (const item of itemsFound) {
        const nomSociete = String(item.nomSociete || '').trim().toUpperCase();
        if (!nomSociete) continue;

        const montant = parseEvaluationMontant(item);

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Députés traités : ${countDeputes}`);
    console.log(`Participations financières extraites : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
