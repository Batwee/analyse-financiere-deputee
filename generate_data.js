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

// Parcours récursif robuste pour capturer les objets contenant un nom de société
function findSocietes(node) {
  let list = [];
  if (!node) return list;

  if (Array.isArray(node)) {
    for (const item of node) {
      list.push(...findSocietes(item));
    }
  } else if (typeof node === 'object') {
    // Si l'objet possède un champ 'nomSociete' ou 'nomOrganisme'
    if (node.nomSociete || node.nomOrganisme) {
      list.push(node);
    }
    // Continue d'explorer les clés enfants
    for (const key of Object.keys(node)) {
      if (typeof node[key] === 'object') {
        list.push(...findSocietes(node[key]));
      }
    }
  }
  return list;
}

// Extrait la valeur numérique depuis n'importe quelle structure (chaine, objet, sous-noeud)
function parseMontant(item) {
  const rawVal = item.evaluation || item.montant || item.valeur || item.remuneration || '0';
  const valStr = typeof rawVal === 'object' ? JSON.stringify(rawVal) : String(rawVal);
  
  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

function isDepute(decla) {
  const jsonStr = JSON.stringify(decla).toLowerCase();
  return (
    jsonStr.includes('dép') ||
    jsonStr.includes('depu') ||
    jsonStr.includes('mandat parlementaire') ||
    jsonStr.includes('assemblée nationale') ||
    jsonStr.includes('assemblee nationale')
  );
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['declaration', 'items'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];

    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    console.log(`Déclarations analysées : ${declarations.length}`);

    const records = [];
    let countDeputes = 0;

    for (const decla of declarations) {
      if (!isDepute(decla)) continue;
      countDeputes++;

      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(
          decla?.qualiteMandat?.labelOrgane || 
          decla?.qualiteMandat?.organe?.label || 
          'Non renseigné'
        ).trim();
      }

      // Analyse de la section participations financieres
      const partSection = decla?.participationsFinancieresDto;
      if (!partSection) continue;

      const itemsFound = findSocietes(partSection);

      for (const item of itemsFound) {
        const nomSociete = String(item.nomSociete || item.nomOrganisme || '').trim().toUpperCase();
        if (!nomSociete) continue;

        const montant = parseMontant(item);

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Déclarations de députés identifiées : ${countDeputes}`);
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
