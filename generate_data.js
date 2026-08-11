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

// Extrait la vraie valeur financière (€) sans capturer l'année
function parseEvaluationMontant(item) {
  // En priorité la valeur d'évaluation des parts/actions
  let rawVal = item.evaluation;

  // Si absent, cherche la rémunération/montant
  if (rawVal === undefined || rawVal === null) {
    rawVal = item.montant || item.valeur || '0';
  }

  // Si c'est un objet (ex: ventilation par année), on cherche la propriété 'montant' ou 'evaluation'
  if (typeof rawVal === 'object') {
    if (rawVal.montant) rawVal = rawVal.montant;
    else if (rawVal.evaluation) rawVal = rawVal.evaluation;
    else rawVal = JSON.stringify(rawVal);
  }

  const valStr = String(rawVal).trim();
  // Nettoie les espaces et extrait la valeur numérique
  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

// Vérification stricte du mandat de député
function isDepute(decla) {
  const qualiteObj = decla?.qualiteMandat || {};
  const qualiteStr = JSON.stringify(qualiteObj).toLowerCase();
  const titre = String(decla?.qualiteDeclarantForAffichage || '').toLowerCase();

  return (
    titre.includes('député') ||
    titre.includes('depute') ||
    qualiteStr.includes('depute') ||
    qualiteStr.includes('député')
  );
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

      // Récupération stricte du nom du député
      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim();

      if (!eluNom || eluNom === 'Inconnu') continue;

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(
          decla?.qualiteMandat?.labelOrgane || 
          decla?.qualiteMandat?.organe?.label || 
          'Non renseigné'
        ).trim();
      }

      // Extraction STRICTE des participations financières en capital/actions
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
    console.log(`Participations financières réelles extraites : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès.`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
