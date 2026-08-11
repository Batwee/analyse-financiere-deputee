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

// Extraction récursive de toutes les participations financières (présence de 'nomSociete')
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

// Détection souple et universelle des députés
function isDeputeDeclaration(decla) {
  // 1. Vérification par champs spécifiques
  const titre = String(decla?.qualiteDeclarantForAffichage || '').toLowerCase();
  const qualite = String(decla?.qualiteMandat?.typeMandat || decla?.qualiteMandat || '').toLowerCase();
  
  if (titre.includes('deput') || titre.includes('déput') || qualite.includes('deput') || qualite.includes('déput')) {
    return true;
  }

  // 2. Repli : inspection du texte sérialisé de la déclaration (limité aux métadonnées du declarant/mandat)
  const declarantStr = JSON.stringify(decla?.declarant || {}).toLowerCase();
  const qualiteStr = JSON.stringify(decla?.qualiteMandat || {}).toLowerCase();
  
  return declarantStr.includes('deput') || qualiteStr.includes('deput') || 
         declarantStr.includes('déput') || qualiteStr.includes('déput');
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['declaration', 'items'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    
    // Récupération souple des déclarations
    let declarations = [];
    if (parsedObj?.declarations?.declaration) {
      declarations = parsedObj.declarations.declaration;
    } else if (parsedObj?.declaration) {
      declarations = parsedObj.declaration;
    } else {
      // Recherche au niveau racine si la structure est modifiée
      declarations = extractParticipations(parsedObj); 
    }

    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    console.log(`Déclarations analysées : ${declarations.length}`);

    const records = [];
    let countDeputes = 0;

    for (const decla of declarations) {
      if (!isDeputeDeclaration(decla)) continue;
      countDeputes++;

      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(decla?.qualiteMandat?.labelOrgane || decla?.qualiteMandat?.organe?.label || 'Non renseigné').trim();
      }

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
      throw new Error("L'extraction n'a renvoyé aucun résultat.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès.`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
