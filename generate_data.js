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

// Extrait la valeur d'évaluation sans lire l'année
function parseEvaluationMontant(item) {
  let rawVal = item.evaluation;

  if (rawVal === undefined || rawVal === null || rawVal === '') {
    rawVal = item.montant || item.valeur || '0';
  }

  if (typeof rawVal === 'object') {
    if (rawVal.evaluation) rawVal = rawVal.evaluation;
    else if (rawVal.montant) rawVal = rawVal.montant;
    else rawVal = JSON.stringify(rawVal);
  }

  const valStr = String(rawVal).trim();
  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

function isDepute(decla) {
  const jsonStr = JSON.stringify(decla).toLowerCase();
  return (
    jsonStr.includes('dép') ||
    jsonStr.includes('depu') ||
    jsonStr.includes('assemblée nationale') ||
    jsonStr.includes('assemblee nationale')
  );
}

// Extrait les participations en cherchant dans toute la structure de la déclaration
function extractParticipations(node) {
  let list = [];
  if (!node) return list;

  if (Array.isArray(node)) {
    for (const item of node) list.push(...extractParticipations(item));
  } else if (typeof node === 'object') {
    // Si c'est un bloc entreprise/société
    const nom = node.nomSociete || node.nom_societe;
    if (nom && typeof nom === 'string' && nom.trim().length > 0) {
      list.push(node);
    }
    for (const key of Object.keys(node)) {
      if (typeof node[key] === 'object') {
        list.push(...extractParticipations(node[key]));
      }
    }
  }
  return list;
}

function getEluNom(decla) {
  const declarant = decla?.declarant || {};
  const prenom = String(declarant.prenom || declarant.prenomDeclarant || '').trim();
  const nom = String(declarant.nom || declarant.nomDeclarant || '').trim();

  if (prenom || nom) {
    return `${prenom} ${nom}`.trim();
  }

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
      isArray: (name) => ['declaration', 'items', 'item'].includes(name)
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

      // On extrait tous les items "société" de la déclaration
      const itemsFound = extractParticipations(decla);

      for (const item of itemsFound) {
        const nomSociete = String(item.nomSociete || item.nom_societe || '').trim().toUpperCase();
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
