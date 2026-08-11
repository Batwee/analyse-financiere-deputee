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

// Parcours récursif pour extraire toutes les participations financières
function extractParticipations(node) {
  let list = [];
  if (!node) return list;

  if (Array.isArray(node)) {
    for (const item of node) {
      list.push(...extractParticipations(item));
    }
  } else if (typeof node === 'object') {
    if (node.nomSociete) {
      list.push(node);
    } else {
      for (const key of Object.keys(node)) {
        list.push(...extractParticipations(node[key]));
      }
    }
  }
  return list;
}

// Vérifie si la déclaration concerne un député
function isDepute(decla) {
  const jsonStr = JSON.stringify(decla).toLowerCase();

  // Mots-clés et identifiants techniques HATVP pour les députés
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

    console.log(`Nombre total de déclarations analysées : ${declarations.length}`);

    const records = [];
    let countDeputes = 0;

    for (const decla of declarations) {
      if (!isDepute(decla)) continue;
      countDeputes++;

      // Nom et Prénom de l'élu
      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      // Parti / Organe politique
      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(
          decla?.qualiteMandat?.labelOrgane || 
          decla?.qualiteMandat?.organe?.label || 
          'Non renseigné'
        ).trim();
      }

      // Section Participations Financières
      const partSection = decla?.participationsFinancieresDto;
      if (!partSection || partSection.neant === true || partSection.neant === 'true') {
        continue;
      }

      const items = extractParticipations(partSection);

      for (const item of items) {
        const nomSociete = String(item?.nomSociete || '').trim().toUpperCase();

        let evaluationRaw = item?.evaluation;
        if (typeof evaluationRaw === 'object') {
          evaluationRaw = JSON.stringify(evaluationRaw);
        } else {
          evaluationRaw = String(evaluationRaw || '0').trim();
        }

        if (!nomSociete) continue;

        // Nettoyage et conversion du montant en chiffre
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

    console.log(`Déclarations de députés identifiées : ${countDeputes}`);
    console.log(`Participations financières extraites : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} mis à jour avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
